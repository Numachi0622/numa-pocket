import "./style.css";
import { renderBoard, type BoardView } from "./board";
import { attachDrag, type DragHandle } from "./drag";
import { FetchError, fetchFolderEntries, isAbortError, type FetchErrorKind } from "./github";
import { groupByColumn, toTasks, type ColumnKey, type Task } from "./parse";
import { attachPullToRefresh, type PullIndicator } from "./pull-to-refresh";
import { isComplete, loadSettings, normalizeFolder, saveSettings, type Settings } from "./settings";

const ERROR_MESSAGES: Record<FetchErrorKind, string> = {
  network: "通信できませんでした",
  auth: "トークンが無効か期限切れです",
  rateLimit: "GitHub の利用制限に達しました",
  repoNotFound: "リポジトリが見つからないか、トークンに権限がありません",
  folderNotFound: "フォルダが見つかりません",
  notFolder: "指定したパスはフォルダではありません",
  unknown: "取得に失敗しました",
};

// Phase 3 の試作: 書き込まずに、この時間の後で保存できたとみなす。
const FAKE_SAVE_MILLISECONDS = 1_000;
const NOTICE_MILLISECONDS = 4_000;

interface MainScreen {
  content: HTMLElement;
  refreshing: HTMLElement;
  notice: HTMLElement;
}

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("#app が見つかりません");
const app: HTMLDivElement = root;

let settings: Settings | null = loadSettings();
let mainScreen: MainScreen | null = null;
let board: BoardView | null = null;
let drag: DragHandle | null = null;

// 画面の元になる状態。ボードは「tasks の列を pending（保存中の移動。ファイル名 → 移動先）で上書きしたもの」を描く。
let tasks: Task[] | null = null;
const pending = new Map<string, ColumnKey>();
let needsRender = false;
let noticeTimer: number | null = null;

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
    tasks = toTasks(entries, settings.folder);
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

  app.replaceChildren(header, pull, notice, content);
  mainScreen = { content, refreshing, notice };
  resetBoard();

  attachPullToRefresh(content, pullIndicator(pull, pullLabel), scrollerOf, () => void refresh(), () => drag?.isActive() ?? false);
}

// ドラッグ中は指の下の要素を消さないよう作り直さず、ドラッグが終わってから描く。
function renderTasks(screen: MainScreen): void {
  if (tasks === null) return;

  if (drag?.isActive()) {
    needsRender = true;
    return;
  }

  needsRender = false;

  const keep: ColumnKey = board?.currentColumn() ?? "today";
  const scrollTops = board?.cardScrollTops() ?? {};
  const columns = groupByColumn(tasks, (task) => pending.get(task.name) ?? task.column);

  const view = renderBoard(columns, new Set(pending.keys()));
  screen.content.replaceChildren(view.element);
  view.showColumn(keep);
  view.restoreCardScrollTops(scrollTops);

  board = view;
  drag = attachDrag(view.element, {
    canLift: (card) => !pending.has(card.dataset.name ?? ""),
    onDrop: (card, to) => moveTask(screen, card.dataset.name ?? "", to),
    onActiveChange: (active) => {
      if (!active && needsRender) {
        renderTasks(screen);
      }
    },
    slide: (direction) => view.slide(direction),
  });
}

function moveTask(screen: MainScreen, name: string, to: ColumnKey): void {
  if (tasks === null || !tasks.some((task) => task.name === name)) return;

  pending.set(name, to);
  renderTasks(screen);
  showNotice(screen, "試作: 保存はまだしません（再取得すると元に戻ります）");

  window.setTimeout(() => completeFakeSave(name, to), FAKE_SAVE_MILLISECONDS);
}

function completeFakeSave(name: string, to: ColumnKey): void {
  pending.delete(name);
  tasks = tasks?.map((task) => (task.name === name ? { ...task, column: to } : task)) ?? null;

  if (mainScreen !== null) {
    renderTasks(mainScreen);
  }
}

function showNotice(screen: MainScreen, message: string): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
  }

  screen.notice.textContent = message;
  screen.notice.hidden = false;
  noticeTimer = window.setTimeout(() => {
    screen.notice.hidden = true;
    noticeTimer = null;
  }, NOTICE_MILLISECONDS);
}

function resetBoard(): void {
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
    field("トークン（Fine-grained PAT, Contents: Read-only）", tokenInput),
    field("owner", ownerInput),
    field("repo", repoInput),
    field("フォルダパス", folderInput),
  );

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

    saveSettings(next);
    settings = next;
    showMain();
    void refresh();
  });

  app.replaceChildren(form);
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
