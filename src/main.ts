import "./style.css";
import { createBoard, type BoardView, type EditTarget, type SubmitResult } from "./board";
import { attachDrag, type DragHandle } from "./drag";
import { DEFAULT_DRAG_TUNING, DRAG_TUNING_FIELDS, loadDragTuning, parseDragTuning, saveDragTuning, type DragTuning } from "./drag-tuning";
import { withStatus } from "./frontmatter";
import { deleteFile, FetchError, fetchFolderEntries, isAbortError, renameFile, SaveError, updateFile, type FetchErrorKind, type SaveErrorKind } from "./github";
import { addCommitMessage, commitMessage, deleteCommitMessage, findWritableNames, groupByColumn, newTask, renameCommitMessage, toTasks, type ColumnKey, type Task } from "./parse";
import { attachPullToRefresh, type PullIndicator } from "./pull-to-refresh";
import { createSaveQueue } from "./save-queue";
import { isComplete, loadSettings, normalizeFolder, saveSettings, type Settings } from "./settings";
import { isSameName, validateRename, validateTitle } from "./task-title";

const ERROR_MESSAGES: Record<FetchErrorKind, string> = {
  network: "通信できませんでした",
  auth: "トークンが無効か期限切れです",
  rateLimit: "GitHub の利用制限に達しました",
  repoNotFound: "リポジトリが見つからないか、トークンに権限がありません",
  folderNotFound: "フォルダが見つかりません",
  notFolder: "指定したパスはフォルダではありません",
  unknown: "取得に失敗しました",
};

const SAVE_ERROR_MESSAGES: Record<SaveErrorKind, string> = {
  conflict: "他の端末で変更されていたので、保存せずに取り直しました",
  exists: "同じ名前のタスクが GitHub にあったので、変更せずに取り直しました",
  auth: "トークンが無効か期限切れのため保存できませんでした",
  forbidden: "トークンに書き込み権限が無いため保存できませんでした",
  rateLimit: "GitHub の利用制限に達したため保存できませんでした",
  unknownResult: "保存できたか確認できませんでした。引っ張って更新で確かめてください",
  unknown: "保存できませんでした",
};

const DUPLICATE_ADD_MESSAGE = "同じ名前のタスクが GitHub にあったので、追加せずに取り直しました";

const NOTICE_MILLISECONDS = 4_000;

/**
 * 保存待ちの移動。ドロップした時点のタスク（sha・本文）を写して持ち、順番が来たときに最新の取得結果から読み直さない。
 * 読み直すと、ドロップの後で取得した他の端末の変更を上書きしてしまうため（仕様 R19）。
 */
interface MoveJob {
  kind: "move";
  task: Task & { text: string };
  to: ColumnKey;
}

/**
 * 保存待ちの追加。task は newTask で作った、まだ GitHub に無いタスク。
 */
interface AddJob {
  kind: "add";
  task: Task & { text: string };
}

/**
 * 保存待ちの名前の変更。from は編集欄を開いた時点のタスク、to は新しい名前にしたタスク（sha・本文・列は from と同じ）。
 */
interface RenameJob {
  kind: "rename";
  from: Task & { text: string };
  to: Task & { text: string };
}

/**
 * 保存待ちの削除。削除を押した時点のタスク（sha）を写して持つ。
 */
interface DeleteJob {
  kind: "delete";
  task: Task;
}

type SaveJob = MoveJob | AddJob | RenameJob | DeleteJob;

interface MainScreen {
  content: HTMLElement;
  refreshing: HTMLElement;
  notice: HTMLElement;
  noticeMessage: HTMLElement;
  noticeDetail: HTMLElement;
}

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("#app が見つかりません");
const app: HTMLDivElement = root;

let settings: Settings | null = loadSettings();
let dragTuning: DragTuning = loadDragTuning();
let mainScreen: MainScreen | null = null;
let board: BoardView | null = null;
let drag: DragHandle | null = null;

// 画面の元になる状態。ボードは tasks に、保存中の操作を重ねたものを描く（visibleTasks を参照）。
// pending: 移動（ファイル名 → 移動先）、pendingAdds: 追加、pendingRenames: 名前の変更（古いファイル名 → 新しい名前のタスク）、pendingDeletes: 削除。
let tasks: Task[] | null = null;
const pending = new Map<string, ColumnKey>();
const pendingAdds = new Map<string, Task & { text: string }>();
const pendingRenames = new Map<string, Task & { text: string }>();
const pendingDeletes = new Set<string>();
let needsRender = false;
let noticeTimer: number | null = null;

const saveQueue = createSaveQueue<SaveJob>((job) => {
  switch (job.kind) {
    case "move":
      return saveMove(job);
    case "add":
      return saveAdd(job);
    case "rename":
      return saveRename(job);
    case "delete":
      return saveDelete(job);
  }
});

// 取得中に次のトリガーが来たら前の取得を中断し、連番が最新の取得の結果だけを画面に反映する。
let latestRequestId = 0;
let inFlight: AbortController | null = null;

start();

function start(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refresh();
      return;
    }

    drag?.cancel();
  });

  if (settings === null || !isComplete(settings)) {
    showSettings();
    return;
  }

  showMain();
  void refresh();
}

async function refresh(): Promise<void> {
  if (settings === null || mainScreen === null) return;

  const screen = mainScreen;
  const requestId = cancelInFlight();
  const controller = new AbortController();
  inFlight = controller;
  screen.refreshing.hidden = false;

  const startedAt = performance.now();

  try {
    const entries = await fetchFolderEntries(settings, controller.signal);
    if (requestId !== latestRequestId) return;

    const fetchedAt = performance.now();
    const writableNames = await findWritableNames(entries);
    if (requestId !== latestRequestId) return;

    tasks = toTasks(entries, settings.folder, writableNames);
    renderTasks(screen);

    const renderedAt = performance.now();
    const textLength = entries.reduce((sum, entry) => sum + (entry.text?.length ?? 0), 0);
    console.info(
      `[numa-pocket] 取得 ${Math.round(fetchedAt - startedAt)} ms / 描画 ${Math.round(renderedAt - fetchedAt)} ms / ${entries.length} 件 / 本文 ${textLength} 文字`,
    );
  } catch (error) {
    if (requestId !== latestRequestId || isAbortError(error)) return;

    console.error("[numa-pocket] 取得に失敗しました", error);
    showError(screen, error);
  } finally {
    if (requestId === latestRequestId) {
      inFlight = null;
      screen.refreshing.hidden = true;
    }
  }
}

function cancelInFlight(): number {
  inFlight?.abort();
  inFlight = null;
  latestRequestId += 1;

  return latestRequestId;
}

function showMain(): void {
  const header = element("header", "header");
  const refreshing = element("span", "refreshing", "更新中...");
  refreshing.hidden = true;

  const settingsButton = element("button", "secondary", "設定");
  settingsButton.addEventListener("click", showSettings);

  const titleGroup = element("div", "title-group");
  titleGroup.append(element("h1", "title", "numa-pocket"), refreshing);
  header.append(titleGroup, settingsButton);

  const pull = element("div", "pull-indicator");
  const pullLabel = element("span", "pull-label");
  pull.append(pullLabel);

  const content = element("main", "content");
  content.append(element("p", "status", "取得中..."));

  const notice = element("div", "notice");
  notice.setAttribute("role", "status");
  notice.hidden = true;

  const noticeMessage = element("p", "notice-message");
  const noticeDetail = element("p", "notice-detail");
  notice.append(noticeMessage, noticeDetail);

  app.replaceChildren(header, pull, notice, content);
  mainScreen = { content, refreshing, notice, noticeMessage, noticeDetail };
  resetBoard();

  attachPullToRefresh(content, pullIndicator(pull, pullLabel), scrollerOf, () => void refresh(), () => drag?.isActive() ?? false);
}

// ドラッグ中は指の下の要素を消さないよう差し替えず、ドラッグが終わってから描く。
function renderTasks(screen: MainScreen): void {
  if (tasks === null) return;

  if (drag?.isActive()) {
    needsRender = true;
    return;
  }

  needsRender = false;

  const view = board ?? mountBoard(screen);
  const columns = groupByColumn(visibleTasks(), (task) => pending.get(task.name) ?? task.column);
  view.update(columns, savingNames());
}

function mountBoard(screen: MainScreen): BoardView {
  const view = createBoard({ onAdd: addTask, editTargetOf, onRename: renameTask, onDelete: deleteTask });
  screen.content.replaceChildren(view.element);
  view.showColumn("today");

  board = view;
  drag = attachDrag(view.element, {
    canLift: (card) => canLift(card.dataset.name ?? ""),
    onDrop: (card, to) => moveTask(screen, card.dataset.name ?? "", to),
    onActiveChange: (active) => {
      if (!active && needsRender) {
        renderTasks(screen);
      }
    },
    slide: (direction) => view.slide(direction),
  }, dragTuning);

  return view;
}

// 名前を変えている途中のタスクは元の位置に新しい名前で、保存中の追加は一番下に出し、削除している途中のタスクは出さない。
// 取得で新しい名前・追加したファイルが先に届いていたら、保存が終わるまで保存中の方を出す。
function visibleTasks(): Task[] {
  const renamedNames = new Set([...pendingRenames.values()].map((task) => task.name));
  const placedRenames = new Set<string>();
  const shown: Task[] = [];

  for (const task of tasks ?? []) {
    if (pendingAdds.has(task.name) || pendingDeletes.has(task.name) || renamedNames.has(task.name)) continue;

    const renamed = pendingRenames.get(task.name);
    if (renamed !== undefined) {
      placedRenames.add(task.name);
      shown.push(renamed);
      continue;
    }

    shown.push(task);
  }

  for (const [fromName, renamed] of pendingRenames) {
    if (!placedRenames.has(fromName)) {
      shown.push(renamed);
    }
  }

  return [...shown, ...pendingAdds.values()];
}

function savingNames(): Set<string> {
  const renamedNames = [...pendingRenames.values()].map((task) => task.name);
  return new Set([...pending.keys(), ...pendingAdds.keys(), ...renamedNames]);
}

function isSaving(name: string): boolean {
  return savingNames().has(name) || pendingRenames.has(name) || pendingDeletes.has(name);
}

// 保存中のカードと、本文をそのまま書き戻せないカード（findWritableNames を参照）は持ち上げない。
function canLift(name: string): boolean {
  if (isSaving(name)) return false;

  const task = tasks?.find((candidate) => candidate.name === name);
  if (task === undefined) return false;

  if (!task.writable) {
    console.warn(`[numa-pocket] ${name} は本文を書き戻せないため動かせません`);
    return false;
  }

  return true;
}

function moveTask(screen: MainScreen, name: string, to: ColumnKey): void {
  const task = tasks?.find((candidate) => candidate.name === name);
  if (task === undefined || task.text === null || !task.writable) return;

  pending.set(name, to);
  renderTasks(screen);

  saveQueue.push({ kind: "move", task: { ...task, text: task.text }, to });
}

function addTask(column: ColumnKey, rawTitle: string): SubmitResult {
  if (settings === null || tasks === null) return { done: false, reason: "ボードを取得してから追加してください" };

  const check = validateTitle(rawTitle, visibleTasks().map((task) => task.name));
  if (!check.ok) return { done: false, reason: check.reason };

  const task = newTask(settings.folder, check.title, column);
  pendingAdds.set(task.name, task);
  rerender();

  saveQueue.push({ kind: "add", task });
  return { done: true, reason: null };
}

// 保存中のカードは編集欄を開かない。本文を書き戻せないカードは開くが、保存・削除はできない。
function editTargetOf(name: string): EditTarget | null {
  if (isSaving(name)) return null;

  const task = tasks?.find((candidate) => candidate.name === name);
  if (task === undefined) return null;

  return { title: task.title, writable: isWritable(task) };
}

function isWritable(task: Task): task is Task & { text: string } {
  return task.writable && task.text !== null;
}

function renameTask(name: string, rawTitle: string): SubmitResult {
  const task = tasks?.find((candidate) => candidate.name === name);
  if (task === undefined || isSaving(name)) return { done: false, reason: "このタスクは今は変更できません" };
  if (!isWritable(task)) return { done: false, reason: null };

  if (rawTitle.trim() === task.title) return { done: true, reason: null };

  const check = validateRename(rawTitle, name, visibleTasks().map((candidate) => candidate.name));
  if (!check.ok) return { done: false, reason: check.reason };

  const folderPrefix = task.path.slice(0, task.path.length - task.name.length);
  const renamed: Task & { text: string } = { ...task, name: check.name, title: check.title, path: `${folderPrefix}${check.name}` };
  pendingRenames.set(name, renamed);
  rerender();

  saveQueue.push({ kind: "rename", from: task, to: renamed });
  return { done: true, reason: null };
}

function deleteTask(name: string): void {
  const task = tasks?.find((candidate) => candidate.name === name);
  if (task === undefined || isSaving(name) || !isWritable(task)) return;

  pendingDeletes.add(name);
  rerender();

  saveQueue.push({ kind: "delete", task });
}

async function saveMove(job: MoveJob): Promise<void> {
  const { task, to } = job;

  try {
    if (settings === null) throw new SaveError("unknown", "設定がありません");

    const content = withStatus(task.text, to);
    const { sha } = await updateFile(settings, { path: task.path, content, sha: task.sha, message: commitMessage(task, to) });

    pending.delete(task.name);
    tasks = tasks?.map((candidate) => (candidate.name === task.name ? { ...candidate, column: to, rawStatus: to, sha, text: content, writable: true } : candidate)) ?? null;
    rerender();

    // 進行中の取得の結果は書き込み前の内容かもしれないので、書き込んだ後から取り直す。
    if (inFlight !== null) {
      void refresh();
    }
  } catch (error) {
    pending.delete(task.name);

    const kind: SaveErrorKind = error instanceof SaveError ? error.kind : "unknown";
    const detail = error instanceof SaveError ? error.detail : String(error);
    console.error(`[numa-pocket] ${task.name} を保存できませんでした`, error);

    rerender();
    notify(SAVE_ERROR_MESSAGES[kind], detail);

    if (kind === "conflict") {
      void refresh();
    }
  }
}

async function saveAdd(job: AddJob): Promise<void> {
  const { task } = job;

  try {
    if (settings === null) throw new SaveError("unknown", "設定がありません");

    const { sha } = await updateFile(settings, { path: task.path, content: task.text, message: addCommitMessage(task.title, task.column) });

    pendingAdds.delete(task.name);
    tasks = replaceOrAppend(tasks, { ...task, sha, writable: true });
    rerender();

    if (inFlight !== null) {
      void refresh();
    }
  } catch (error) {
    pendingAdds.delete(task.name);

    const kind: SaveErrorKind = error instanceof SaveError ? error.kind : "unknown";
    const detail = error instanceof SaveError ? error.detail : String(error);
    console.error(`[numa-pocket] ${task.name} を追加できませんでした`, error);

    rerender();

    if (kind !== "conflict") {
      notify(SAVE_ERROR_MESSAGES[kind], detail);
      return;
    }

    // 競合に寄せている 409 / 404 / 422 のどれが返ったかでは同名かどうかを決めきれないので、取り直して確かめる。
    void refresh().then(() => {
      const exists = tasks?.some((candidate) => isSameName(candidate.name, task.name)) ?? false;
      notify(exists ? DUPLICATE_ADD_MESSAGE : SAVE_ERROR_MESSAGES.unknown, detail);
    });
  }
}

async function saveRename(job: RenameJob): Promise<void> {
  const { from, to } = job;

  try {
    if (settings === null) throw new SaveError("unknown", "設定がありません");

    await renameFile(settings, { fromPath: from.path, toPath: to.path, content: from.text, sha: from.sha, message: renameCommitMessage(from.title, to.title) });

    pendingRenames.delete(from.name);
    tasks = replaceRenamed(tasks, from.name, { ...to, writable: true });
    rerender();

    if (inFlight !== null) {
      void refresh();
    }
  } catch (error) {
    pendingRenames.delete(from.name);
    handleSaveFailure(error, `${from.name} の名前を変えられませんでした`);
  }
}

async function saveDelete(job: DeleteJob): Promise<void> {
  const { task } = job;

  try {
    if (settings === null) throw new SaveError("unknown", "設定がありません");

    await deleteFile(settings, { path: task.path, sha: task.sha, message: deleteCommitMessage(task.title) });

    pendingDeletes.delete(task.name);
    tasks = tasks?.filter((candidate) => candidate.name !== task.name) ?? null;
    rerender();

    if (inFlight !== null) {
      void refresh();
    }
  } catch (error) {
    pendingDeletes.delete(task.name);
    handleSaveFailure(error, `${task.name} を削除できませんでした`);
  }
}

// 画面を保存前に戻して知らせる。他の端末の変更とぶつかったときは取り直す。
function handleSaveFailure(error: unknown, logMessage: string): void {
  const kind: SaveErrorKind = error instanceof SaveError ? error.kind : "unknown";
  const detail = error instanceof SaveError ? error.detail : String(error);
  console.error(`[numa-pocket] ${logMessage}`, error);

  rerender();
  notify(SAVE_ERROR_MESSAGES[kind], detail);

  if (kind === "conflict" || kind === "exists") {
    void refresh();
  }
}

// 古い名前のタスクを新しい名前のタスクに置き換える。取得で新しい名前が先に届いていたらそちらは除き、古い名前が無ければ末尾に足す。
function replaceRenamed(current: Task[] | null, fromName: string, renamed: Task): Task[] | null {
  if (current === null) return null;

  const others = current.filter((candidate) => candidate.name !== renamed.name);
  if (!others.some((candidate) => candidate.name === fromName)) return [...others, renamed];

  return others.map((candidate) => (candidate.name === fromName ? renamed : candidate));
}

function replaceOrAppend(current: Task[] | null, task: Task): Task[] | null {
  if (current === null) return null;

  if (current.some((candidate) => candidate.name === task.name)) {
    return current.map((candidate) => (candidate.name === task.name ? task : candidate));
  }

  return [...current, task];
}

function notify(message: string, detail: string): void {
  if (mainScreen === null) return;

  showNotice(mainScreen, message, detail);
}

function rerender(): void {
  if (mainScreen === null) return;

  renderTasks(mainScreen);
}

function showNotice(screen: MainScreen, message: string, detail: string): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
  }

  screen.noticeMessage.textContent = message;
  screen.noticeDetail.textContent = detail;
  screen.notice.hidden = false;
  noticeTimer = window.setTimeout(() => {
    screen.notice.hidden = true;
    noticeTimer = null;
  }, NOTICE_MILLISECONDS);
}

function resetBoard(): void {
  board?.destroy();
  drag?.cancel();
  drag = null;
  board = null;
  tasks = null;
}

function showError(screen: MainScreen, error: unknown): void {
  resetBoard();

  const kind: FetchErrorKind = error instanceof FetchError ? error.kind : "unknown";
  const detail = error instanceof FetchError ? error.detail : String(error);

  const section = element("section", "error");
  section.append(element("p", "error-message", ERROR_MESSAGES[kind]), element("p", "error-detail", detail));

  const retry = element("button", "primary", "再試行");
  retry.addEventListener("click", () => void refresh());

  const openSettings = element("button", "secondary", "設定を開く");
  openSettings.addEventListener("click", showSettings);

  section.append(retry, openSettings);
  screen.content.replaceChildren(section);
}

function showSettings(): void {
  cancelInFlight();
  mainScreen = null;
  resetBoard();

  const current = settings;
  const form = element("form", "settings");
  form.append(element("h1", "title", "設定"));

  const tokenInput = input("token", "password", "");
  tokenInput.placeholder = current?.token ? "保存済み（変更するときだけ入力）" : "github_pat_...";
  tokenInput.autocomplete = "off";

  const ownerInput = input("owner", "text", current?.owner ?? "");
  ownerInput.placeholder = "GitHub のユーザー名";

  const repoInput = input("repo", "text", current?.repo ?? "");
  repoInput.placeholder = "リポジトリ名";

  const folderInput = input("folder", "text", current?.folder ?? "");
  folderInput.placeholder = "フォルダ/パス";

  form.append(
    field("トークン（Fine-grained PAT, Contents: Read and write）", tokenInput),
    field("owner", ownerInput),
    field("repo", repoInput),
    field("フォルダパス", folderInput),
  );

  const tuningInputs = tuningSection(form, dragTuning);

  const message = element("p", "form-message");
  const submit = element("button", "primary", "保存");
  submit.type = "submit";
  form.append(message, submit);

  if (current !== null && isComplete(current)) {
    const cancel = element("button", "secondary", "キャンセル");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      showMain();
      void refresh();
    });
    form.append(cancel);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const parsedTuning = parseDragTuning(tuningInputsValues(tuningInputs));
    const next: Settings = {
      token: tokenInput.value.trim() || current?.token || "",
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      folder: normalizeFolder(folderInput.value),
    };

    if (!isComplete(next)) {
      message.textContent = "4 項目すべてを入力してください";
      return;
    }

    if (parsedTuning.tuning === null) {
      message.textContent = parsedTuning.errors.join("\n");
      return;
    }

    saveSettings(next);
    settings = next;
    saveDragTuning(parsedTuning.tuning);
    dragTuning = parsedTuning.tuning;
    showMain();
    void refresh();
  });

  app.replaceChildren(form);
}

// 実機で操作感を詰めるための数値。保存ボタンで設定と一緒に保存する（仕様 未決 #6）。
function tuningSection(form: HTMLFormElement, current: DragTuning): Record<keyof DragTuning, HTMLInputElement> {
  const section = element("fieldset", "tuning");
  section.append(element("legend", "tuning-legend", "操作の調整"));

  const inputs = {} as Record<keyof DragTuning, HTMLInputElement>;
  for (const tuningField of DRAG_TUNING_FIELDS) {
    const control = input(tuningField.key, "number", String(current[tuningField.key]));
    control.inputMode = "numeric";
    control.min = String(tuningField.min);
    control.max = String(tuningField.max);
    control.step = "1";

    const label = `${tuningField.label}（${tuningField.unit}、初期値 ${DEFAULT_DRAG_TUNING[tuningField.key]}）`;
    section.append(field(label, control));
    inputs[tuningField.key] = control;
  }

  const reset = element("button", "secondary", "初期値に戻す");
  reset.type = "button";
  reset.addEventListener("click", () => {
    for (const tuningField of DRAG_TUNING_FIELDS) {
      inputs[tuningField.key].value = String(DEFAULT_DRAG_TUNING[tuningField.key]);
    }
  });

  section.append(reset);
  form.append(section);
  return inputs;
}

function tuningInputsValues(inputs: Record<keyof DragTuning, HTMLInputElement>): Record<keyof DragTuning, string> {
  return {
    longPressMs: inputs.longPressMs.value,
    moveTolerancePx: inputs.moveTolerancePx.value,
    edgeZonePx: inputs.edgeZonePx.value,
    edgeDwellMs: inputs.edgeDwellMs.value,
  };
}

// ボード上ではタッチした列のカード一覧、それ以外（取得中・エラー）ではメイン領域が縦スクロールする要素。
function scrollerOf(touchTarget: EventTarget | null): HTMLElement | null {
  if (!(touchTarget instanceof Element)) return null;

  const cards = touchTarget.closest(".column")?.querySelector<HTMLElement>(".cards");
  return cards ?? touchTarget.closest<HTMLElement>(".content");
}

function pullIndicator(container: HTMLElement, label: HTMLElement): PullIndicator {
  return {
    update(distance, reachedThreshold) {
      container.style.height = `${distance}px`;
      label.textContent = reachedThreshold ? "離して更新" : "引っ張って更新";
    },
    reset() {
      container.style.height = "0px";
      label.textContent = "";
    },
  };
}

function field(label: string, control: HTMLInputElement): HTMLLabelElement {
  const wrapper = element("label", "field");
  wrapper.append(element("span", "field-label", label), control);
  return wrapper;
}

function input(name: string, type: string, value: string): HTMLInputElement {
  const control = element("input", "field-input");
  control.name = name;
  control.type = type;
  control.value = value;
  control.autocapitalize = "off";
  control.spellcheck = false;
  return control;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}
