import { COLUMN_ORDER, type ColumnKey, type Columns } from "./parse";

const COLUMN_LABELS: Record<ColumnKey, string> = {
  idea: "Idea",
  today: "Today",
  done: "Done",
};

/**
 * 各列のカード一覧の縦スクロール位置。
 */
export type CardScrollTops = Partial<Record<ColumnKey, number>>;

/**
 * 描画したボード。element を DOM に入れた後で showColumn を呼ぶと、その列が画面の左側の列になる（右端の列はスクロールの端で止まる）。
 */
export interface BoardView {
  element: HTMLElement;
  showColumn(key: ColumnKey): void;
  currentColumn(): ColumnKey;
  /**
   * 左右どちらかに 1 列分スライドする。それ以上スライドできない方向なら何もせず false を返す。
   */
  slide(direction: -1 | 1): boolean;
  cardScrollTops(): CardScrollTops;
  restoreCardScrollTops(tops: CardScrollTops): void;
}

/**
 * 3 列のボードを描画する。列は横スクロール（scroll-snap）で 1 画面 2 列、カードはタイトルのみでタップしても何もしない。
 * カードには data-name にファイル名を持たせ、saving に含まれるカードには保存中の印を付ける。
 * タイトルは textContent で入れる（ファイル名を HTML として解釈させないため）。
 */
export function renderBoard(columns: Columns, saving: ReadonlySet<string>): BoardView {
  const board = document.createElement("div");
  board.className = "board";

  const columnElements = new Map<ColumnKey, HTMLElement>();
  for (const key of COLUMN_ORDER) {
    const column = renderColumn(key, columns, saving);
    columnElements.set(key, column);
    board.append(column);
  }

  const scrollLeftOf = (key: ColumnKey): number | null => {
    const column = columnElements.get(key);
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
    for (const [key, column] of columnElements) {
      const distance = Math.abs(column.offsetLeft - left);
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

  const cardScrollTops = (): CardScrollTops => {
    const tops: CardScrollTops = {};
    for (const [key, column] of columnElements) {
      tops[key] = cardsOf(column)?.scrollTop ?? 0;
    }

    return tops;
  };

  const restoreCardScrollTops = (tops: CardScrollTops) => {
    for (const [key, column] of columnElements) {
      const cards = cardsOf(column);
      const top = tops[key];
      if (cards === null || top === undefined) continue;

      cards.scrollTop = top;
    }
  };

  return { element: board, showColumn, currentColumn, slide, cardScrollTops, restoreCardScrollTops };
}

function leftPadding(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).paddingLeft) || 0;
}

function cardsOf(column: HTMLElement): HTMLElement | null {
  return column.querySelector<HTMLElement>(".cards");
}

function renderColumn(key: ColumnKey, columns: Columns, saving: ReadonlySet<string>): HTMLElement {
  const tasks = columns[key];

  const column = document.createElement("section");
  column.className = "column";
  column.dataset.column = key;

  const heading = document.createElement("h2");
  heading.className = "column-heading";

  const label = document.createElement("span");
  label.textContent = COLUMN_LABELS[key];

  const count = document.createElement("span");
  count.className = "column-count";
  count.textContent = String(tasks.length);

  heading.append(label, count);

  const cards = document.createElement("ul");
  cards.className = "cards";
  for (const task of tasks) {
    const card = document.createElement("li");
    card.className = saving.has(task.name) ? "card card--saving" : "card";
    card.dataset.name = task.name;
    card.textContent = task.title;
    cards.append(card);
  }

  column.append(heading, cards);
  return column;
}
