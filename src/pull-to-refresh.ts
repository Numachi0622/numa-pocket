const THRESHOLD_PIXELS = 70;
const AXIS_LOCK_PIXELS = 8;
const MAX_OFFSET_PIXELS = 80;
const DAMPING = 0.5;

/**
 * 引っ張って更新の表示を受け持つ要素。distance は 0 以上で、reachedThreshold は離したら更新されるかを表す。
 */
export interface PullIndicator {
  update(distance: number, reachedThreshold: boolean): void;
  reset(): void;
}

interface PullState {
  startX: number;
  startY: number;
  scroller: HTMLElement | null;
  mode: "pull" | "ignore" | null;
  distance: number;
}

/**
 * target の中で、縦スクロールが一番上にあるときの下方向の引っ張りを追い、しきい値を超えて離したら onRefresh を呼ぶ。
 * 最初の移動で引っ張りかどうかを決めて固定する。横方向・上方向・スクロール途中なら標準のスクロール（横スワイプを含む）に任せる。
 * scrollerOf はタッチ位置から縦スクロールする要素を返す。null なら常に一番上とみなす。
 * isSuspended が true を返す間（カードのドラッグ中など）は引っ張りとして扱わない。
 */
export function attachPullToRefresh(
  target: HTMLElement,
  indicator: PullIndicator,
  scrollerOf: (touchTarget: EventTarget | null) => HTMLElement | null,
  onRefresh: () => void,
  isSuspended: () => boolean = () => false,
): void {
  let state: PullState | null = null;

  target.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        state = null;
        return;
      }

      const touch = event.touches[0];
      state = { startX: touch.clientX, startY: touch.clientY, scroller: scrollerOf(event.target), mode: null, distance: 0 };
    },
    { passive: true },
  );

  target.addEventListener(
    "touchmove",
    (event) => {
      if (state === null || event.touches.length !== 1) return;

      if (isSuspended()) {
        if (state.mode === "pull") {
          indicator.reset();
        }

        state.mode = "ignore";
        return;
      }

      const touch = event.touches[0];
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;

      if (state.mode === null) {
        if (Math.abs(dx) < AXIS_LOCK_PIXELS && Math.abs(dy) < AXIS_LOCK_PIXELS) return;

        const atTop = state.scroller === null || state.scroller.scrollTop <= 0;
        const isPull = Math.abs(dy) > Math.abs(dx) && dy > 0 && atTop;
        state.mode = isPull ? "pull" : "ignore";
      }

      if (state.mode !== "pull") return;

      // 引っ張り中は iOS 標準のスクロールとバウンスを止め、自前の表示だけにする。
      event.preventDefault();

      state.distance = Math.max(0, dy);
      indicator.update(Math.min(state.distance * DAMPING, MAX_OFFSET_PIXELS), state.distance >= THRESHOLD_PIXELS);
    },
    { passive: false },
  );

  const finish = (shouldRefresh: boolean) => {
    if (state === null) return;

    const reached = state.mode === "pull" && state.distance >= THRESHOLD_PIXELS;
    state = null;
    indicator.reset();

    if (shouldRefresh && reached) {
      onRefresh();
    }
  };

  target.addEventListener("touchend", () => finish(true));
  target.addEventListener("touchcancel", () => finish(false));
}
