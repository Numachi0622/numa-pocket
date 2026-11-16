import { COLUMN_ORDER, type ColumnKey, type Columns, type Task } from "./parse";

const TAP_TOLERANCE_PX = 10;

const COLUMN_LABELS: Record<ColumnKey, string> = {
  idea: "Idea",
  today: "Today",
  done: "Done",
};

/**
 * 追加フォーム・編集欄から送られたタイトルを受け取った結果。
 * done なら追加フォームは入力欄を空にし、編集欄は閉じる。そうでなければ reason（null なら何も出さない）を入力欄の下に出して文字を残す。
 */
export interface SubmitResult {
  done: boolean;
  reason: string | null;
}

/**
 * 編集欄を開くカードの情報。writable でなければ「保存」「削除」を押せないようにして理由を出す。
 */
export interface EditTarget {
  title: string;
  writable: boolean;
}

/**
 * ボードの外から受け取る処理。
 */
export interface BoardOptions {
  onAdd(column: ColumnKey, title: string): SubmitResult;
  /**
   * タップしたカードの編集欄を開いてよいかを返す。保存中などで開かないときは null。
   */
  editTargetOf(name: string): EditTarget | null;
  onRename(name: string, title: string): SubmitResult;
  onDelete(name: string): void;
}

/**
 * 描画したボード。element を DOM に入れた後で showColumn を呼ぶと、その列が画面の左側の列になる（右端の列はスクロールの端で止まる）。
 * 状態が変わったら update でカード一覧と件数だけを差し替える。ボード・列・追加フォームは作り直さないので、横位置・縦スクロール位置・入力中の文字が残る。
 */
export interface BoardView {
  element: HTMLElement;
  showColumn(key: ColumnKey): void;
  currentColumn(): ColumnKey;
  /**
   * 左右どちらかに 1 列分スライドする。それ以上スライドできない方向なら何もせず false を返す。
   */
  slide(direction: -1 | 1): boolean;
  /**
   * 各列のカードと件数を差し替える。カードには data-name にファイル名を持たせ、saving に含まれるカードには保存中の印を付ける。
   */
  update(columns: Columns, saving: ReadonlySet<string>): void;
  /**
   * document に付けたイベントを外す。ボードを捨てるときに呼ぶ。
   */
  destroy(): void;
}

interface ColumnParts {
  element: HTMLElement;
  count: HTMLElement;
  cards: HTMLElement;
  add: AddForm;
}

interface AddForm {
  element: HTMLElement;
  open(): void;
  close(): void;
  contains(target: Node): boolean;
}

/**
 * 3 列のボードを作る。列は横スクロール（scroll-snap）で 1 画面 2 列、カードはタイトルのみ。各列の下に「+」から開く追加フォームを置く。
 * カードをタップすると、そのカードの位置に編集欄（名前の変更・削除）を開く。
 * 追加フォームと編集欄は合わせて同時に 1 つだけ開き、「やめる」か外のタップで閉じる。
 */
export function createBoard(options: BoardOptions): BoardView {
  const board = document.createElement("div");
  board.className = "board";

  let openColumn: ColumnKey | null = null;
  let editing: { name: string; column: ColumnKey } | null = null;
  let lastColumns: Columns = { idea: [], today: [], done: [] };
  let lastSaving: ReadonlySet<string> = new Set();

  const editor = createEditor({
    submit: (title) => (editing === null ? { done: true, reason: null } : options.onRename(editing.name, title)),
    remove: () => {
      if (editing !== null) {
        options.onDelete(editing.name);
      }
    },
    close: () => closeEditor(),
  });

  const openAddForm = (key: ColumnKey) => {
    closeEditor();
    if (openColumn !== null && openColumn !== key) {
      columnParts.get(openColumn)?.add.close();
    }

    openColumn = key;
    columnParts.get(key)?.add.open();
  };

  const closeAddForm = () => {
    if (openColumn === null) return;

    columnParts.get(openColumn)?.add.close();
    openColumn = null;
  };

  const openEditor = (card: HTMLElement) => {
    const name = card.dataset.name;
    const column = card.closest<HTMLElement>(".column[data-column]")?.dataset.column as ColumnKey | undefined;
    if (name === undefined || column === undefined) return;

    const target = options.editTargetOf(name);
    if (target === null) return;

    closeAddForm();
    closeEditor();

    // 同じ列の編集欄を閉じると列が描き直されるので、押したカードを名前で探し直す。
    const current = [...(columnParts.get(column)?.cards.children ?? [])].find((child) => child instanceof HTMLElement && child.dataset.name === name);
    if (current === undefined) return;

    editing = { name, column };
    current.replaceWith(editor.element);
    editor.open(target);
  };

  // 編集欄を外して、そのカードを元に戻す（列のカードを描き直す）。
  function closeEditor(): void {
    if (editing === null) return;

    const column = editing.column;
    editing = null;
    editor.close();
    editor.element.remove();
    renderCards(column);
  }

  const columnParts = new Map<ColumnKey, ColumnParts>();
  for (const key of COLUMN_ORDER) {
    const parts = createColumn(key, {
      open: () => openAddForm(key),
      close: closeAddForm,
      submit: (title) => options.onAdd(key, title),
    });
    columnParts.set(key, parts);
    board.append(parts.element);
  }

  // 外を「タップ」したときだけ閉じる。スクロール・横スワイプ・引っ張って更新の始まりでは閉じない（入力中の文字を捨てないため。仕様 R22）。
  // 閉じるだけで、そのタップ自体は止めない。
  let outsideTap: { pointerId: number; x: number; y: number } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    outsideTap = null;
    if (!(event.target instanceof Node)) return;
    if (openColumn === null && editing === null) return;
    if (openColumn !== null && columnParts.get(openColumn)?.add.contains(event.target)) return;
    if (editing !== null && editor.element.contains(event.target)) return;

    // カードのタップは click の側で、今開いているものを閉じてからそのカードの編集欄を開く。
    // ここで閉じると click の前に列が描き直され、押したカードが DOM から外れて開けなくなるため。
    if (event.target instanceof Element && event.target.closest(".card[data-name]") !== null && board.contains(event.target)) return;

    outsideTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (outsideTap === null || event.pointerId !== outsideTap.pointerId) return;

    if (Math.hypot(event.clientX - outsideTap.x, event.clientY - outsideTap.y) > TAP_TOLERANCE_PX) {
      outsideTap = null;
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (outsideTap === null || event.pointerId !== outsideTap.pointerId) return;

    outsideTap = null;
    closeAddForm();
    closeEditor();
  };

  const onPointerCancel = () => {
    outsideTap = null;
  };

  const documentListeners = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
  ] as const;
  for (const [type, listener] of documentListeners) {
    document.addEventListener(type, listener, true);
  }

  // 長押しが成立しなかったタップでは click が来る（ドラッグの後は drag.ts が click を止める）。
  board.addEventListener("click", (event) => {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>(".card[data-name]") : null;
    if (card === null || !board.contains(card)) return;

    openEditor(card);
  });

  const scrollLeftOf = (key: ColumnKey): number | null => {
    const column = columnParts.get(key)?.element;
    if (column === undefined) return null;

    return column.offsetLeft - board.offsetLeft - leftPadding(board);
  };

  const showColumn = (key: ColumnKey) => {
    const left = scrollLeftOf(key);
    if (left === null) return;

    board.scrollLeft = left;
  };

  const currentColumn = (): ColumnKey => {
    const left = board.scrollLeft + board.offsetLeft + leftPadding(board);

    let nearest: ColumnKey = "today";
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [key, parts] of columnParts) {
      const distance = Math.abs(parts.element.offsetLeft - left);
      if (distance < nearestDistance) {
        nearest = key;
        nearestDistance = distance;
      }
    }

    return nearest;
  };

  // 1 画面 2 列なので、左側に来られるのは右端の列を除いた列だけ。
  const slide = (direction: -1 | 1): boolean => {
    const index = COLUMN_ORDER.indexOf(currentColumn()) + direction;
    if (index < 0 || index > COLUMN_ORDER.length - 2) return false;

    const left = scrollLeftOf(COLUMN_ORDER[index]);
    if (left === null) return false;

    board.scrollTo({ left, behavior: "smooth" });
    return true;
  };

  // 編集欄を開いているときは、編集欄の要素を DOM から外さずに周りのカードだけを差し替える。
  // 一度でも外すと focus が外れて iOS のキーボードが閉じるため。
  function renderCards(key: ColumnKey): void {
    const parts = columnParts.get(key);
    if (parts === undefined) return;

    const tasks = lastColumns[key];
    parts.count.textContent = String(tasks.length);

    const editingName = editing?.column === key ? editing.name : null;
    const nodes = tasks.map((task) => (task.name === editingName ? editor.element : renderCard(task, lastSaving)));
    const editorIndex = nodes.indexOf(editor.element);
    if (editorIndex < 0 || editor.element.parentElement !== parts.cards) {
      parts.cards.replaceChildren(...nodes);
      return;
    }

    for (const child of [...parts.cards.children]) {
      if (child !== editor.element) {
        child.remove();
      }
    }

    for (const node of nodes.slice(0, editorIndex)) {
      parts.cards.insertBefore(node, editor.element);
    }

    parts.cards.append(...nodes.slice(editorIndex + 1));
  }

  const update = (columns: Columns, saving: ReadonlySet<string>) => {
    lastColumns = columns;
    lastSaving = saving;

    // 編集中のタスクが消えた・別の列に移った・保存中になった（名前の変更・削除の直後）ときは閉じる。
    if (editing !== null) {
      const name = editing.name;
      const stillHere = columns[editing.column].some((task) => task.name === name) && !saving.has(name);
      if (!stillHere) {
        editing = null;
        editor.close();
        editor.element.remove();
      }
    }

    for (const key of COLUMN_ORDER) {
      renderCards(key);
    }
  };

  const destroy = () => {
    for (const [type, listener] of documentListeners) {
      document.removeEventListener(type, listener, true);
    }
  };

  return { element: board, showColumn, currentColumn, slide, update, destroy };
}

interface EditorHandlers {
  submit(title: string): SubmitResult;
  remove(): void;
  close(): void;
}

interface Editor {
  element: HTMLElement;
  open(target: EditTarget): void;
  close(): void;
}

const UNWRITABLE_REASON = "本文を正しく読めなかったタスクなので、変更・削除できません";

// 編集欄。1 つの要素を使い回し、タップしたカードの位置に置く。
function createEditor(handlers: EditorHandlers): Editor {
  const item = document.createElement("li");
  item.className = "card-edit";

  const form = document.createElement("form");
  form.className = "add-form";

  const input = createTitleInput();

  const message = document.createElement("p");
  message.className = "add-message";

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = "保存";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "やめる";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete";

  const actions = document.createElement("div");
  actions.className = "add-actions";
  actions.append(save, cancel);

  form.append(input, message, actions, remove);
  item.append(form);

  let armed = false;
  const disarm = () => {
    armed = false;
    remove.textContent = "削除";
    remove.classList.remove("delete--armed");
  };

  // 「保存」「削除」を押しても入力欄から focus を移さない。1 回目の「削除」でキーボードが閉じて画面がずれ、2 回目が別の場所に当たるのを防ぐ。
  keepFocusOnPress(save);
  keepFocusOnPress(remove);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled) return;

    disarm();

    const result = handlers.submit(input.value);
    if (result.done) {
      handlers.close();
      return;
    }

    message.textContent = result.reason ?? "";
    input.focus();
  });

  cancel.addEventListener("click", handlers.close);

  remove.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      remove.textContent = "本当に削除";
      remove.classList.add("delete--armed");
      return;
    }

    disarm();
    handlers.remove();
    handlers.close();
  });

  return {
    element: item,
    open(target) {
      disarm();
      input.value = target.title;
      message.textContent = target.writable ? "" : UNWRITABLE_REASON;
      save.disabled = !target.writable;
      remove.disabled = !target.writable;
      input.focus();
    },
    close() {
      disarm();
      input.blur();
      message.textContent = "";
    },
  };
}

function createTitleInput(): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "add-input";
  input.type = "text";
  input.name = "title";
  input.placeholder = "タイトル";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.enterKeyHint = "enter";

  // 日本語入力の変換を確定する Enter で、変換途中のタイトルを送らない。
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  });

  return input;
}

function keepFocusOnPress(button: HTMLButtonElement): void {
  for (const type of ["pointerdown", "mousedown"] as const) {
    button.addEventListener(type, (event) => event.preventDefault());
  }
}

function leftPadding(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).paddingLeft) || 0;
}

// タイトルは textContent で入れる（ファイル名を HTML として解釈させないため）。
function renderCard(task: Task, saving: ReadonlySet<string>): HTMLElement {
  const card = document.createElement("li");
  card.className = saving.has(task.name) ? "card card--saving" : "card";
  card.dataset.name = task.name;
  card.textContent = task.title;
  return card;
}

interface AddFormHandlers {
  open(): void;
  close(): void;
  submit(title: string): SubmitResult;
}

function createColumn(key: ColumnKey, handlers: AddFormHandlers): ColumnParts {
  const column = document.createElement("section");
  column.className = "column";
  column.dataset.column = key;

  const heading = document.createElement("h2");
  heading.className = "column-heading";

  const label = document.createElement("span");
  label.textContent = COLUMN_LABELS[key];

  const count = document.createElement("span");
  count.className = "column-count";

  heading.append(label, count);

  const cards = document.createElement("ul");
  cards.className = "cards";

  const add = createAddForm(COLUMN_LABELS[key], handlers);

  column.append(heading, cards, add.element);
  return { element: column, count, cards, add };
}

function createAddForm(columnLabel: string, handlers: AddFormHandlers): AddForm {
  const container = document.createElement("div");
  container.className = "column-add";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "add-open";
  openButton.textContent = "+";
  openButton.setAttribute("aria-label", `${columnLabel} にタスクを追加`);

  const form = document.createElement("form");
  form.className = "add-form";
  form.hidden = true;

  const input = createTitleInput();

  const message = document.createElement("p");
  message.className = "add-message";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary add-submit";
  submit.textContent = "追加";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary add-cancel";
  cancel.textContent = "やめる";

  const actions = document.createElement("div");
  actions.className = "add-actions";
  actions.append(submit, cancel);

  form.append(input, message, actions);
  container.append(openButton, form);

  // 「追加」を押しても入力欄から focus を移さず、キーボードを閉じない（続けて入れるため。仕様 R22）。
  keepFocusOnPress(submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const result = handlers.submit(input.value);
    if (result.done) {
      input.value = "";
    }

    message.textContent = result.reason ?? "";
    input.focus();
  });

  openButton.addEventListener("click", handlers.open);
  cancel.addEventListener("click", handlers.close);

  return {
    element: container,
    open() {
      openButton.hidden = true;
      form.hidden = false;
      input.focus();
    },
    close() {
      input.blur();
      input.value = "";
      message.textContent = "";
      form.hidden = true;
      openButton.hidden = false;
    },
    contains: (target) => container.contains(target),
  };
}
