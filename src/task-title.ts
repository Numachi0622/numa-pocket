const MARKDOWN_EXTENSION = ".md";
const MAX_NAME_BYTES = 255;

// Windows と Obsidian でファイル名に使えない文字と、Obsidian のリンクで使えない文字。
const FORBIDDEN_CHARACTERS = /[\\/:*?"<>|#^[\]]/;

/**
 * タイトルを確かめた結果。ok でなければ reason に入力欄の下に出す理由を入れる。空のタイトルは reason が null（何もしない）。
 */
export type TitleCheck = { ok: true; title: string; name: string } | { ok: false; reason: string | null };

/**
 * 追加するタスクのタイトルを確かめる。前後の空白を除き、ファイル名にできない・表示中のタスクと同じ名前になるものを弾く。
 * 同じ名前の判定は、大文字・小文字と Unicode の正規化の違いを無視する（Windows・macOS では同じファイルになるため）。
 */
export function validateTitle(raw: string, existingNames: Iterable<string>): TitleCheck {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, reason: null };

  if (FORBIDDEN_CHARACTERS.test(title)) {
    return { ok: false, reason: '使えない文字が入っています（\\ / : * ? " < > | # ^ [ ]）' };
  }

  if (title.startsWith(".") || title.endsWith(".")) {
    return { ok: false, reason: "「.」で始まる・終わるタイトルは使えません" };
  }

  const name = `${title}${MARKDOWN_EXTENSION}`;
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    return { ok: false, reason: "タイトルが長すぎます" };
  }

  const key = nameKey(name);
  for (const existing of existingNames) {
    if (nameKey(existing) === key) return { ok: false, reason: "同じ名前のタスクがあります" };
  }

  return { ok: true, title, name };
}

/**
 * 大文字・小文字と Unicode の正規化の違いを無視して、2 つのファイル名が同じかを返す。
 */
export function isSameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
