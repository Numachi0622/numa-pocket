import type { DragTuning } from "./drag-tuning";
import type { ColumnKey } from "./parse";

const SLIDE_SETTLE_MS = 400;
const LIFT_SCALE = 1.05;

/**
 * ドラッグが呼び出し側に問い合わせ・通知すること。
 */
export interface DragOptions {
  /** このカードを持ち上げてよいか（保存中のカードは false）。 */
  canLift(card: HTMLElement): boolean;
  /** 別の列の上で離したとき。 */
  onDrop(card: HTMLElement, to: ColumnKey): void;
  /** ドラッグが始まった・終わったとき（取り消しを含む）。 */
  onActiveChange(active: boolean): void;
  /** 左右に 1 列分スライドする。できなければ false。 */
  slide(direction: -1 | 1): boolean;
}

/**
 * 呼び出し側からドラッグを扱うための口。
 */
export interface DragHandle {
  isActive(): boolean;
  /** 進行中の長押し・ドラッグを取り消す（アプリがバックグラウンドに回ったときなど）。 */
  cancel(): void;
}

interface Pressing {
  kind: "pressing";
  card: HTMLElement;
  touchId: number;
  startX: number;
  startY: number;
  timer: number;
}

interface Dragging {
  kind: "dragging";
  card: HTMLElement;
  ghost: HTMLElement;
  touchId: number;
  grabOffsetX: number;
  grabOffsetY: number;
  originLeft: number;
  originTop: number;
  x: number;
  y: number;
  origin: ColumnKey;
  target: HTMLElement | null;
  edgeDirection: -1 | 1 | null;
  edgeTimer: number | null;
  sliding: boolean;
}

type DragState = { kind: "idle" } | Pressing | Dragging;

/**
 * board の中のカード（.card[data-name]）を長押しで持ち上げ、別の列（.column[data-column]）へドラッグ＆ドロップできるようにする。
 * 長押しが成立する前に指が動いたら何もせず、標準のスクロール・横スワイプ・引っ張って更新に任せる。
 * ドラッグ中は touchmove を止め、指が左右の端のゾーンに一定時間留まったら options.slide で 1 列分スライドする。
 * 長押しの時間・指のずれの許容・端のゾーン・端で待つ時間は tuning に従う。
 */
export function attachDrag(board: HTMLElement, options: DragOptions, tuning: DragTuning): DragHandle {
  let state: DragState = { kind: "idle" };

  const finish = (dropTo: ColumnKey | null) => {
    if (state.kind === "pressing") {
      window.clearTimeout(state.timer);
      state = { kind: "idle" };
      return;
    }

    if (state.kind !== "dragging") return;

    const dragging = state;
    state = { kind: "idle" };

    if (dragging.edgeTimer !== null) {
      window.clearTimeout(dragging.edgeTimer);
    }

    dragging.ghost.remove();
    dragging.card.classList.remove("card--lifted");
    dragging.target?.classList.remove("column--target");
    board.classList.remove("board--dragging");
    board.removeEventListener("scroll", onBoardScroll);

    options.onActiveChange(false);

    if (dropTo !== null && dropTo !== dragging.origin) {
      options.onDrop(dragging.card, dropTo);
    }
  };

  const startDragging = (pressing: Pressing) => {
    const card = pressing.card;
    const origin = columnKeyOf(card);
    if (origin === null) {
      state = { kind: "idle" };
      return;
    }

    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true) as HTMLElement;
    ghost.classList.add("drag-ghost");
    ghost.classList.remove("card--saving");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.append(ghost);

    card.classList.add("card--lifted");
    board.classList.add("board--dragging");
    board.addEventListener("scroll", onBoardScroll, { passive: true });

    state = {
      kind: "dragging",
      card,
      ghost,
      touchId: pressing.touchId,
      grabOffsetX: pressing.startX - rect.left,
      grabOffsetY: pressing.startY - rect.top,
      originLeft: rect.left,
      originTop: rect.top,
      x: pressing.startX,
      y: pressing.startY,
      origin,
      target: null,
      edgeDirection: null,
      edgeTimer: null,
      sliding: false,
    };

    moveGhost(state);
    updateTarget(state);
    options.onActiveChange(true);
  };

  const updateTarget = (dragging: Dragging) => {
    const target = columnAt(board, dragging.x, dragging.y);
    if (target === dragging.target) return;

    dragging.target?.classList.remove("column--target");
    target?.classList.add("column--target");
    dragging.target = target;
  };

  const updateEdge = (dragging: Dragging) => {
    const direction = edgeDirectionAt(board, dragging.x, tuning.edgeZonePx);
    if (direction === dragging.edgeDirection) return;

    if (dragging.edgeTimer !== null) {
      window.clearTimeout(dragging.edgeTimer);
      dragging.edgeTimer = null;
    }

    dragging.edgeDirection = direction;
    if (direction === null || dragging.sliding) return;

    dragging.edgeTimer = window.setTimeout(() => slideTowardEdge(dragging), tuning.edgeDwellMs);
  };

  // スライド中は次のスライドを始めない。落ち着いた後もまだ端にいれば、もう一度留まる時間を数える。
  const slideTowardEdge = (dragging: Dragging) => {
    dragging.edgeTimer = null;
    if (state !== dragging || dragging.edgeDirection === null) return;
    if (!options.slide(dragging.edgeDirection)) return;

    dragging.sliding = true;
    window.setTimeout(() => {
      dragging.sliding = false;
      if (state !== dragging) return;

      dragging.edgeDirection = null;
      updateEdge(dragging);
    }, SLIDE_SETTLE_MS);
  };

  // スライドしても指は動かず touchmove が来ないので、スクロールのたびにドロップ先を判定し直す。
  function onBoardScroll(): void {
    if (state.kind !== "dragging") return;

    updateTarget(state);
  }

  board.addEventListener(
    "touchstart",
    (event) => {
      if (state.kind !== "idle") {
        finish(null);
        return;
      }

      if (event.touches.length !== 1) return;

      const card = event.target instanceof Element ? event.target.closest<HTMLElement>(".card[data-name]") : null;
      if (card === null || !board.contains(card) || !options.canLift(card)) return;

      const touch = event.touches[0];
      const pressing: Pressing = {
        kind: "pressing",
        card,
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        timer: 0,
      };
      pressing.timer = window.setTimeout(() => {
        if (state === pressing) {
          startDragging(pressing);
        }
      }, tuning.longPressMs);

      state = pressing;
    },
    { passive: true },
  );

  board.addEventListener(
    "touchmove",
    (event) => {
      if (state.kind === "idle") return;

      const touch = findTouch(event.touches, state.touchId);
      if (touch === null) return;

      if (state.kind === "pressing") {
        const moved = Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY);
        if (moved > tuning.moveTolerancePx) {
          finish(null);
        }
        return;
      }

      // ドラッグ中は縦スクロール・横スワイプを起こさない。
      if (event.cancelable) {
        event.preventDefault();
      }

      state.x = touch.clientX;
      state.y = touch.clientY;
      moveGhost(state);
      updateTarget(state);
      updateEdge(state);
    },
    { passive: false },
  );

  board.addEventListener("touchend", (event) => {
    if (state.kind === "idle") return;
    if (findTouch(event.changedTouches, state.touchId) === null) return;

    if (state.kind === "dragging") {
      const target = columnAt(board, state.x, state.y);
      finish(target === null ? null : columnKeyOf(target));
      return;
    }

    finish(null);
  });

  board.addEventListener("touchcancel", () => finish(null));

  return {
    isActive: () => state.kind === "dragging",
    cancel: () => finish(null),
  };
}

function moveGhost(dragging: Dragging): void {
  const dx = dragging.x - dragging.grabOffsetX - dragging.originLeft;
  const dy = dragging.y - dragging.grabOffsetY - dragging.originTop;
  dragging.ghost.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${LIFT_SCALE})`;
}

// 浮かせたカードは pointer-events: none なので、指の下の列がそのまま取れる。
function columnAt(board: HTMLElement, x: number, y: number): HTMLElement | null {
  const column = document.elementFromPoint(x, y)?.closest<HTMLElement>(".column[data-column]") ?? null;
  return column !== null && board.contains(column) ? column : null;
}

function edgeDirectionAt(board: HTMLElement, x: number, zone: number): -1 | 1 | null {
  const rect = board.getBoundingClientRect();
  if (x < rect.left + zone) return -1;
  if (x > rect.right - zone) return 1;

  return null;
}

function columnKeyOf(element: Element): ColumnKey | null {
  const key = element.closest<HTMLElement>(".column[data-column]")?.dataset.column;
  return key === "idea" || key === "today" || key === "done" ? key : null;
}

function findTouch(touches: TouchList, id: number): Touch | null {
  for (const touch of Array.from(touches)) {
    if (touch.identifier === id) return touch;
  }

  return null;
}
