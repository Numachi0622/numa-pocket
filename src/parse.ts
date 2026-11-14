import type { FolderEntry } from "./github";

/**
 * 列の種類。frontmatter の `status` の値と一致させている。
 */
export type ColumnKey = "idea" | "today" | "done";

/**
 * 列ごとのカードのタイトル。列内の順序は取得した順のまま。
 */
export type Columns = Record<ColumnKey, string[]>;

const MARKDOWN_EXTENSION = ".md";
const FRONTMATTER_DELIMITER = "---";
const STATUS_LINE = /^status:(.*)$/;

/**
 * フォルダ直下のエントリを、frontmatter の `status` で Idea / Today / Done に振り分ける。
 * サブフォルダと `.md` 以外のファイルは無視し、`status` が無い・読めない・想定外の値なら idea にする。
 */
export function toColumns(entries: FolderEntry[]): Columns {
  const columns: Columns = { idea: [], today: [], done: [] };

  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.name.endsWith(MARKDOWN_EXTENSION)) continue;

    const title = entry.name.slice(0, -MARKDOWN_EXTENSION.length);
    columns[readStatus(entry.text ?? "")].push(title);
  }

  return columns;
}

/**
 * 本文の frontmatter から `status` を読む。idea / today / done 以外はすべて idea として返す。
 */
export function readStatus(text: string): ColumnKey {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== FRONTMATTER_DELIMITER) return "idea";

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FRONTMATTER_DELIMITER);
  if (closingIndex < 0) return "idea";

  for (const line of lines.slice(1, closingIndex)) {
    const match = STATUS_LINE.exec(line);
    if (match === null) continue;

    return toColumnKey(readScalar(match[1]));
  }

  return "idea";
}

// YAML のスカラー値のうち、status で使う範囲（引用符付き・行末コメント付き）だけを読む。
function readScalar(raw: string): string {
  const value = raw.trim();

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closing = value.indexOf(quote, 1);
    return closing < 0 ? value : value.slice(1, closing);
  }

  return value.replace(/(^|\s)#.*$/, "").trim();
}

function toColumnKey(value: string): ColumnKey {
  return value === "today" || value === "done" ? value : "idea";
}
