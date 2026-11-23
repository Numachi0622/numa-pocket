import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDrag } from "./drag";
import { DEFAULT_DRAG_TUNING } from "./drag-tuning";

class TestElement extends EventTarget {
  constructor(kind, parent = null) {
    super();
    this.kind = kind;
    this.parent = parent;
    this.dataset = kind === "column" ? { column: "today" } : { name: "task.md" };
    this.style = {};
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach((value) => classes.add(value)), remove: (...values) => values.forEach((value) => classes.delete(value)) };
  }

  contains(element) {
    return element === this || (element.parent ? this.contains(element.parent) : false);
  }

  closest(selector) {
    const kind = selector.startsWith(".card") ? "card" : "column";
    return this.kind === kind ? this : this.parent?.closest(selector) ?? null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 180, height: 40, right: 600 };
  }

  cloneNode() { return new TestElement(this.kind); }
  remove() {}
}

function dispatch(target, type, values = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
  return event;
}

function fixture() {
  const windowTarget = new EventTarget();
  windowTarget.setTimeout = (...args) => setTimeout(...args);
  windowTarget.clearTimeout = (id) => clearTimeout(id);
  const board = new TestElement("board");
  const today = new TestElement("column", board);
  const done = new TestElement("column", board);
  done.dataset.column = "done";
  const card = new TestElement("card", today);
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("document", { body: { append: vi.fn() }, elementFromPoint: (x) => x < 0 ? null : x > 200 ? done : today });
  const options = { canLift: vi.fn(() => true), onDrop: vi.fn(), onActiveChange: vi.fn(), slide: vi.fn(() => true) };
  const handle = attachDrag(board, options, DEFAULT_DRAG_TUNING);
  const mouse = (target, type, extra = {}) => dispatch(target, type, { pointerId: 7, pointerType: "mouse", button: 0, buttons: 1, clientX: 30, clientY: 20, ...extra });
  return { board, card, options, handle, mouse, windowTarget };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("マウスのドラッグ", () => {
  it("長押し不要で列を移動し、直後のclickだけを抑止する", () => {
    const { board, card, options, handle, mouse, windowTarget } = fixture();
    mouse(board, "pointerdown", { target: card });
    mouse(windowTarget, "pointermove", { clientX: 260 });
    expect(handle.isActive()).toBe(true);
    mouse(windowTarget, "pointerup", { clientX: 260, buttons: 0 });
    expect(options.onDrop).toHaveBeenCalledWith(card, "done");
    expect(handle.isActive()).toBe(false);
    expect(dispatch(board, "click").defaultPrevented).toBe(true);
    mouse(board, "pointerdown", { target: card });
    mouse(windowTarget, "pointerup", { buttons: 0 });
    expect(dispatch(board, "click").defaultPrevented).toBe(false);
  });

  it("通常クリックと小さな手ぶれではドラッグしない", () => {
    const { board, card, options, handle, mouse, windowTarget } = fixture();
    mouse(board, "pointerdown", { target: card });
    mouse(windowTarget, "pointermove", { clientX: 32 });
    vi.advanceTimersByTime(1000);
    expect(handle.isActive()).toBe(false);
    mouse(windowTarget, "pointerup", { buttons: 0 });
    expect(options.onDrop).not.toHaveBeenCalled();
    expect(dispatch(board, "click").defaultPrevented).toBe(false);
  });

  it.each(["blur", "pointercancel", "Escape"])("%s で取り消して保存しない", (reason) => {
    const { board, card, options, handle, mouse, windowTarget } = fixture();
    mouse(board, "pointerdown", { target: card });
    mouse(windowTarget, "pointermove", { clientX: 260 });
    dispatch(windowTarget, reason === "Escape" ? "keydown" : reason, { key: reason });
    expect(handle.isActive()).toBe(false);
    mouse(windowTarget, "pointerup", { clientX: 260 });
    expect(options.onDrop).not.toHaveBeenCalled();
  });

  it("右ボタン・保存中のカードを持ち上げない", () => {
    const { board, card, options, handle, mouse, windowTarget } = fixture();
    mouse(board, "pointerdown", { target: card, button: 2 });
    mouse(windowTarget, "pointermove", { clientX: 260 });
    expect(handle.isActive()).toBe(false);
    options.canLift.mockReturnValue(false);
    mouse(board, "pointerdown", { target: card });
    mouse(windowTarget, "pointermove", { clientX: 260 });
    expect(handle.isActive()).toBe(false);
  });
});

describe("タッチのドラッグを維持する", () => {
  it("長押し後に列へドロップでき、編集を開くclickを防ぐ", () => {
    const { board, card, options, handle } = fixture();
    const touch = { identifier: 1, clientX: 30, clientY: 20 };
    dispatch(board, "touchstart", { target: card, touches: [touch] });
    vi.advanceTimersByTime(DEFAULT_DRAG_TUNING.longPressMs - 1);
    expect(handle.isActive()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(handle.isActive()).toBe(true);
    const moved = { ...touch, clientX: 260 };
    expect(dispatch(board, "touchmove", { touches: [moved] }).defaultPrevented).toBe(true);
    expect(dispatch(board, "touchend", { changedTouches: [moved] }).defaultPrevented).toBe(true);
    expect(options.onDrop).toHaveBeenCalledWith(card, "done");
  });

  it("長押し前に動いたらスクロールに任せる", () => {
    const { board, card, options, handle } = fixture();
    const touch = { identifier: 1, clientX: 30, clientY: 20 };
    dispatch(board, "touchstart", { target: card, touches: [touch] });
    expect(dispatch(board, "touchmove", { touches: [{ ...touch, clientY: 60 }] }).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(DEFAULT_DRAG_TUNING.longPressMs);
    expect(handle.isActive()).toBe(false);
    expect(options.onDrop).not.toHaveBeenCalled();
  });
});
