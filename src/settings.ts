const STORAGE_KEY = "numa-pocket:settings";

/**
 * 取得先のリポジトリとフォルダ、読み取り用トークン。localStorage にだけ保存する。
 */
export interface Settings {
  token: string;
  owner: string;
  repo: string;
  folder: string;
}

/**
 * フォルダパスの前後の空白と、先頭・末尾の `/` を取り除く。
 */
export function normalizeFolder(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * 4 項目すべてが入力済みかを返す。
 */
export function isComplete(settings: Settings): boolean {
  return [settings.token, settings.owner, settings.repo, settings.folder].every((value) => value.length > 0);
}

/**
 * 保存済みの設定を読む。未保存なら null。壊れた値は原因を console.error に出して null を返す。
 */
export function loadSettings(): Settings | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSettingsShape(parsed)) {
      console.error("[numa-pocket] 保存済みの設定の形式が不正なため無視します");
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("[numa-pocket] 保存済みの設定を JSON として読めないため無視します", error);
    return null;
  }
}

/**
 * 設定を保存する。設定画面の保存時だけ呼ぶ。
 */
export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function isSettingsShape(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  return ["token", "owner", "repo", "folder"].every((key) => typeof record[key] === "string");
}
