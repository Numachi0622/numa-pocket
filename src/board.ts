import { COLUMN_ORDER, type ColumnKey, type Columns, type Task } from "./parse";

const TAP_TOLERANCE_PX = 10;

const COLUMN_LABELS: Record<ColumnKey, string> = {
  idea: "Idea",
  today: "Today",
  done: "Done",
};

/**
 * 追加フォームから送られたタイトルを受け取った結果。added なら入力欄を空にし、そうでなければ reason を入力欄の下に出して文字を残す。
 */
export interface AddResult {
  added: boolean;
  reason: string | null;
}

/**
 * ボードの外から受け取る処理。
 */
export interface BoardOptions {
  onAdd(column: ColumnKey, title: string): AddResult;
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
 * フォームは同時に 1 列だけ開き、「やめる」かフォームの外のタップで閉じる。
 */
export function createBoard(options: BoardOptions): BoardView {
  const board = document.createElement("div");
  board.className = "board";

  let openColumn: ColumnKey | null = null;

  const openAddForm = (key: ColumnKey) => {
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
    if (openColumn === null || !(event.target instanceof Node)) return;
    if (columnParts.get(openColumn)?.add.contains(event.target)) return;

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

  const update = (columns: Columns, saving: ReadonlySet<string>) => {
    for (const [key, parts] of columnParts) {
      const tasks = columns[key];
      parts.count.textContent = String(tasks.length);
      parts.cards.replaceChildren(...tasks.map((task) => renderCard(task, saving)));
    }
  };

  const destroy = () => {
    for (const [type, listener] of documentListeners) {
      document.removeEventListener(type, listener, true);
    }
  };

  return { element: board, showColumn, currentColumn, slide, update, destroy };
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
  submit(title: string): AddResult;
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

  const input = document.createElement("input");
  input.className = "add-input";
  input.type = "text";
  input.name = "title";
  input.placeholder = "タイトル";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.enterKeyHint = "enter";

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
  for (const type of ["pointerdown", "mousedown"] as const) {
    submit.addEventListener(type, (event) => event.preventDefault());
  }

  // 日本語入力の変換を確定する Enter で、変換途中のタイトルを追加しない。
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const result = handlers.submit(input.value);
    if (result.added) {
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
