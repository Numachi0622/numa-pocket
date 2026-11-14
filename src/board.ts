import type { ColumnKey, Columns } from "./parse";

const COLUMN_ORDER: readonly ColumnKey[] = ["idea", "today", "done"];

const COLUMN_LABELS: Record<ColumnKey, string> = {
  idea: "Idea",
  today: "Today",
  done: "Done",
};

/**
 * 描画したボード。element を DOM に入れた後で showColumn を呼ぶと、その列が中央に来る。
 */
export interface BoardView {
  element: HTMLElement;
  showColumn(key: ColumnKey): void;
  currentColumn(): ColumnKey;
}

/**
 * 3 列のボードを描画する。列は横スクロール（scroll-snap）で 1 画面 1 列、カードはタイトルのみでタップしても何もしない。
 * タイトルは textContent で入れる（ファイル名を HTML として解釈させないため）。
 */
export function renderBoard(columns: Columns): BoardView {
  const board = document.createElement("div");
  board.className = "board";

  const columnElements = new Map<ColumnKey, HTMLElement>();
  for (const key of COLUMN_ORDER) {
    const column = renderColumn(key, columns[key]);
    columnElements.set(key, column);
    board.append(column);
  }

  const showColumn = (key: ColumnKey) => {
    const column = columnElements.get(key);
    if (column === undefined) return;

    board.scrollLeft = column.offsetLeft - (board.clientWidth - column.clientWidth) / 2;
  };

  const currentColumn = (): ColumnKey => {
    const center = board.scrollLeft + board.clientWidth / 2;

    let nearest: ColumnKey = "today";
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [key, column] of columnElements) {
      const distance = Math.abs(column.offsetLeft + column.clientWidth / 2 - center);
      if (distance < nearestDistance) {
        nearest = key;
        nearestDistance = distance;
      }
    }

    return nearest;
  };

  return { element: board, showColumn, currentColumn };
}

function renderColumn(key: ColumnKey, titles: string[]): HTMLElement {
  const column = document.createElement("section");
  column.className = "column";
  column.dataset.column = key;

  const heading = document.createElement("h2");
  heading.className = "column-heading";

  const label = document.createElement("span");
  label.textContent = COLUMN_LABELS[key];

  const count = document.createElement("span");
  count.className = "column-count";
  count.textContent = String(titles.length);

  heading.append(label, count);

  const cards = document.createElement("ul");
  cards.className = "cards";
  for (const title of titles) {
    const card = document.createElement("li");
    card.className = "card";
    card.textContent = title;
    cards.append(card);
  }

  column.append(heading, cards);
  return column;
}
