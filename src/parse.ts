import type { FolderEntry } from "./github";

/**
 * 列の種類。frontmatter の `status` の値と一致させている。
 */
export type ColumnKey = "idea" | "today" | "done";

/**
 * 列の並び順（左から）。
 */
export const COLUMN_ORDER: readonly ColumnKey[] = ["idea", "today", "done"];

/**
 * フォルダ直下のタスクファイル 1 件。
 */
export interface Task {
  /** ファイル名。GraphQL が返した文字列をそのまま使い、パスの組み立てにも使う。 */
  name: string;
  /** ファイル名から末尾の `.md` を除いたもの。カードに表示する。 */
  title: string;
  /** リポジトリのルートからのパス。 */
  path: string;
  /** 本文。取れなかった（バイナリなど）ときは null。 */
  text: string | null;
  /** `status` で振り分けた列。 */
  column: ColumnKey;
  /** ファイル上の `status` の値（引用符・行末コメントを除いたもの）。`status` が無ければ null。 */
  rawStatus: string | null;
}

/**
 * 列ごとのタスク。列内の順序は取得した順のまま。
 */
export type Columns = Record<ColumnKey, Task[]>;

const MARKDOWN_EXTENSION = ".md";
const FRONTMATTER_DELIMITER = "---";
const STATUS_LINE = /^status:(.*)$/;

/**
 * フォルダ直下のエントリから、タスクファイルだけを Task にする。
 * サブフォルダと `.md` 以外のファイルは無視し、`status` が無い・読めない・想定外の値なら idea の列にする。
 */
export function toTasks(entries: FolderEntry[], folder: string): Task[] {
  const tasks: Task[] = [];

  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.name.endsWith(MARKDOWN_EXTENSION)) continue;

    const rawStatus = entry.text === null ? null : readRawStatus(entry.text);
    tasks.push({
      name: entry.name,
      title: entry.name.slice(0, -MARKDOWN_EXTENSION.length),
      path: `${folder}/${entry.name}`,
      text: entry.text,
      column: toColumnKey(rawStatus),
      rawStatus,
    });
  }

  return tasks;
}

/**
 * タスクを列ごとに分ける。columnOf を渡すと、その列で振り分ける（保存中の移動を反映するため）。
 */
export function groupByColumn(tasks: Task[], columnOf: (task: Task) => ColumnKey = (task) => task.column): Columns {
  const columns: Columns = { idea: [], today: [], done: [] };

  for (const task of tasks) {
    columns[columnOf(task)].push(task);
  }

  return columns;
}

/**
 * 本文の frontmatter から `status` を読む。idea / today / done 以外はすべて idea として返す。
 */
export function readStatus(text: string): ColumnKey {
  return toColumnKey(readRawStatus(text));
}

/**
 * 本文の frontmatter にあるトップレベルの `status` の値を、引用符と行末コメントを除いて返す。frontmatter や `status` が無ければ null。
 */
export function readRawStatus(text: string): string | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== FRONTMATTER_DELIMITER) return null;

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FRONTMATTER_DELIMITER);
  if (closingIndex < 0) return null;

  for (const line of lines.slice(1, closingIndex)) {
    const match = STATUS_LINE.exec(line);
    if (match === null) continue;

    return readScalar(match[1]);
  }

  return null;
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

function toColumnKey(value: string | null): ColumnKey {
  return value === "today" || value === "done" ? value : "idea";
}
