const STORAGE_KEY = "numa-pocket:drag-tuning";

/**
 * ドラッグの操作感を決める数値。実機で調整できるよう、設定画面から変えて localStorage に保存する（仕様 未決 #6）。
 */
export interface DragTuning {
  /** 長押しが成立するまでの時間（ms）。 */
  longPressMs: number;
  /** 長押しが成立する前に、これより指が動いたら長押しをやめる距離（px）。 */
  moveTolerancePx: number;
  /** ボードの左右の端から、スライドのために指を留めるゾーンの幅（px）。 */
  edgeZonePx: number;
  /** 端のゾーンにこの時間留まったら 1 列スライドする（ms）。 */
  edgeDwellMs: number;
}

/**
 * 項目ごとの表示名・単位・入力できる範囲。
 */
export interface DragTuningField {
  key: keyof DragTuning;
  label: string;
  unit: "ms" | "px";
  min: number;
  max: number;
}

/**
 * 保存された値が無いときの値。
 */
export const DEFAULT_DRAG_TUNING: Readonly<DragTuning> = {
  longPressMs: 200,
  moveTolerancePx: 8,
  edgeZonePx: 40,
  edgeDwellMs: 500,
};

/**
 * 設定画面に並べる順の項目。
 */
export const DRAG_TUNING_FIELDS: readonly DragTuningField[] = [
  { key: "longPressMs", label: "長押しの時間", unit: "ms", min: 50, max: 1500 },
  { key: "moveTolerancePx", label: "長押し中の指のずれの許容", unit: "px", min: 2, max: 40 },
  { key: "edgeZonePx", label: "端スクロールのゾーンの幅", unit: "px", min: 10, max: 120 },
  { key: "edgeDwellMs", label: "端で待つ時間", unit: "ms", min: 0, max: 2000 },
];

/**
 * 入力された文字列を検証して DragTuning にする。整数でない・範囲外の項目があれば、その項目の名前を errors に入れて返す。
 */
export function parseDragTuning(inputs: Record<keyof DragTuning, string>): { tuning: DragTuning | null; errors: string[] } {
  const tuning: DragTuning = { ...DEFAULT_DRAG_TUNING };
  const errors: string[] = [];

  for (const field of DRAG_TUNING_FIELDS) {
    const raw = inputs[field.key].trim();
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < field.min || value > field.max) {
      errors.push(`${field.label}は ${field.min}〜${field.max} ${field.unit} の整数にしてください`);
      continue;
    }

    tuning[field.key] = value;
  }

  return { tuning: errors.length === 0 ? tuning : null, errors };
}

/**
 * 保存済みの値を読む。未保存なら初期値。壊れた値・範囲外の値は原因を console.error に出して初期値を返す。
 */
export function loadDragTuning(): DragTuning {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return { ...DEFAULT_DRAG_TUNING };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidTuning(parsed)) {
      console.error("[numa-pocket] 保存済みのドラッグの調整値が不正なため初期値を使います", parsed);
      return { ...DEFAULT_DRAG_TUNING };
    }

    return parsed;
  } catch (error) {
    console.error("[numa-pocket] 保存済みのドラッグの調整値を JSON として読めないため初期値を使います", error);
    return { ...DEFAULT_DRAG_TUNING };
  }
}

/**
 * 値を保存する。初期値と同じなら保存を消し、後で初期値を変えたときにそちらが効くようにする。
 */
export function saveDragTuning(tuning: DragTuning): void {
  if (isSameTuning(tuning, DEFAULT_DRAG_TUNING)) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
}

function isValidTuning(value: unknown): value is DragTuning {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  return DRAG_TUNING_FIELDS.every((field) => {
    const item = record[field.key];
    return typeof item === "number" && Number.isInteger(item) && item >= field.min && item <= field.max;
  });
}

function isSameTuning(a: DragTuning, b: DragTuning): boolean {
  return DRAG_TUNING_FIELDS.every((field) => a[field.key] === b[field.key]);
}
