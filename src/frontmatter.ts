const FRONTMATTER_DELIMITER = "---";
const BOM = "﻿";

/**
 * frontmatter のトップレベルの `status` 行。1 つ目のグループが `status:` の後ろの値の部分。
 */
export const STATUS_LINE = /^status:(.*)$/;

/**
 * 改行で分けた行（改行文字を含まない）から、frontmatter の閉じの `---` の行番号を返す。
 * 1 行目が `---` で、2 行目以降に閉じの `---` があるときだけ frontmatter とみなす。無ければ null。
 */
export function findFrontmatterEnd(lines: readonly string[]): number | null {
  if (lines[0]?.trimEnd() !== FRONTMATTER_DELIMITER) return null;

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FRONTMATTER_DELIMITER);
  return closingIndex < 0 ? null : closingIndex;
}

/**
 * 本文の `status` だけを next に変えた本文を返す。status 以外の行・改行コード・BOM は変えない。
 * frontmatter が無ければ先頭に足し、`status` が無ければ閉じの `---` の直前に足す。
 * 既存の `status` 行は値だけを置き換え、行末コメントは残し、引用符は付けない。
 */
export function withStatus(text: string, next: string): string {
  const bom = text.startsWith(BOM) ? BOM : "";
  const body = text.slice(bom.length);
  const newline = newlineOf(body);

  // 偶数番目が行、奇数番目がその行の後ろの改行。行ごとの改行コードをそのまま残すために分けて持つ。
  const parts = body.split(/(\r?\n)/);
  const lines = parts.filter((_, index) => index % 2 === 0);

  const closingIndex = findFrontmatterEnd(lines);
  if (closingIndex === null) {
    return `${bom}${FRONTMATTER_DELIMITER}${newline}status: ${next}${newline}${FRONTMATTER_DELIMITER}${newline}${body}`;
  }

  for (let index = 1; index < closingIndex; index++) {
    const match = STATUS_LINE.exec(lines[index]);
    if (match === null) continue;

    parts[index * 2] = `status: ${next}${trailingComment(match[1])}`;
    return bom + parts.join("");
  }

  parts.splice(closingIndex * 2, 0, `status: ${next}`, newline);
  return bom + parts.join("");
}

// 最初の改行が CRLF なら CRLF、それ以外（LF・改行なし）は LF とみなす。
function newlineOf(body: string): "\r\n" | "\n" {
  const index = body.indexOf("\n");
  return index > 0 && body[index - 1] === "\r" ? "\r\n" : "\n";
}

// 値の後ろの行末コメント（前の空白を含む）を返す。無ければ空文字列。
function trailingComment(raw: string): string {
  const value = raw.trimStart();
  const quote = value[0];

  if (quote === '"' || quote === "'") {
    const closing = value.indexOf(quote, 1);
    if (closing < 0) return "";

    const rest = value.slice(closing + 1);
    return /^\s+#/.test(rest) ? rest : "";
  }

  return /\s+#.*$/.exec(value)?.[0] ?? "";
}
