const STORAGE_KEY = "numa-pocket:column-width";

/** PC の列幅の初期値（px）。768px 未満ではスマホ用の2列表示を使う。 */
export const DEFAULT_COLUMN_WIDTH = 320;

/** 設定に入力した列幅を検証する。 */
export function parseColumnWidth(raw: string): number | null {
  const value = Number(raw);
  return raw.trim() !== "" && Number.isInteger(value) && value >= 160 && value <= 800 ? value : null;
}

/** 保存した列幅を読む。古い設定には初期値を使う。 */
export function loadColumnWidth(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return DEFAULT_COLUMN_WIDTH;

  const value = parseColumnWidth(raw);
  if (value !== null) return value;

  console.error("[numa-pocket] 保存済みの列幅が不正なため初期値を使います");
  return DEFAULT_COLUMN_WIDTH;
}

/** 設定で指定した列幅を保存する。 */
export function saveColumnWidth(width: number): void {
  if (parseColumnWidth(String(width)) === null) throw new Error("PC の列幅は160〜800pxの整数にしてください");

  localStorage.setItem(STORAGE_KEY, String(width));
}
