import { describe, expect, it } from "vitest";
import type { FolderEntry } from "./github";
import { readStatus, toColumns } from "./parse";

function file(name: string, text: string | null): FolderEntry {
  return { name, type: "blob", text };
}

describe("readStatus", () => {
  it.each([
    ["idea", "---\nstatus: idea\n---\n本文"],
    ["today", "---\nstatus: today\n---\n本文"],
    ["done", "---\nstatus: done\n---\n本文"],
  ])("status: %s をその列にする", (expected, text) => {
    expect(readStatus(text)).toBe(expected);
  });

  it("status が無ければ idea", () => {
    expect(readStatus("---\ntags: [a]\n---\n本文")).toBe("idea");
  });

  it("frontmatter が無ければ idea", () => {
    expect(readStatus("status: today\n本文")).toBe("idea");
  });

  it("本文が空なら idea", () => {
    expect(readStatus("")).toBe("idea");
  });

  it("閉じの --- が無ければ frontmatter 無しとみなして idea", () => {
    expect(readStatus("---\nstatus: today\n本文")).toBe("idea");
  });

  it("閉じの --- より後の status は読まない", () => {
    expect(readStatus("---\ntags: []\n---\nstatus: today")).toBe("idea");
  });

  it.each(["wip", "Today", "DONE", "today!", ""])("想定外の値 %j は idea", (value) => {
    expect(readStatus(`---\nstatus: ${value}\n---`)).toBe("idea");
  });

  it.each([
    ["today", '---\nstatus: "today"\n---'],
    ["done", "---\nstatus: 'done'\n---"],
    ["today", '---\nstatus: "today" # 引用符の後のコメント\n---'],
  ])("引用符付きの値を読む (%s)", (expected, text) => {
    expect(readStatus(text)).toBe(expected);
  });

  it("行末コメントを除いて読む", () => {
    expect(readStatus("---\nstatus: done # 11/12 に完了\n---")).toBe("done");
  });

  it("# の前に空白が無ければコメントとみなさない", () => {
    expect(readStatus("---\nstatus: done#memo\n---")).toBe("idea");
  });

  it("CRLF の改行を許容する", () => {
    expect(readStatus("---\r\nstatus: today\r\n---\r\n本文")).toBe("today");
  });

  it("先頭の BOM を許容する", () => {
    expect(readStatus("﻿---\nstatus: done\n---")).toBe("done");
  });

  it("インデントされた status はトップレベルではないので読まない", () => {
    expect(readStatus("---\nmeta:\n  status: today\n---")).toBe("idea");
  });

  it("status: の後に空白が無くても読む", () => {
    expect(readStatus("---\nstatus:today\n---")).toBe("today");
  });
});

describe("toColumns", () => {
  it("status ごとに振り分け、タイトルはファイル名から .md を除いたもの", () => {
    const columns = toColumns([
      file("牛乳を買う.md", "---\nstatus: today\n---"),
      file("アイデア.md", "本文だけ"),
      file("終わった.md", "---\nstatus: done\n---"),
      file("作業中.md", "---\nstatus: wip\n---"),
    ]);

    expect(columns).toEqual({
      idea: ["アイデア", "作業中"],
      today: ["牛乳を買う"],
      done: ["終わった"],
    });
  });

  it("サブフォルダは無視する", () => {
    const columns = toColumns([{ name: "archive.md", type: "tree", text: null }]);

    expect(columns).toEqual({ idea: [], today: [], done: [] });
  });

  it(".md 以外のファイルは無視する", () => {
    const columns = toColumns([file("image.png", null), file("memo.txt", "---\nstatus: today\n---"), file("README", "")]);

    expect(columns).toEqual({ idea: [], today: [], done: [] });
  });

  it("拡張子は大文字小文字を区別し、.MD は無視する", () => {
    const columns = toColumns([file("大文字.MD", "---\nstatus: today\n---")]);

    expect(columns).toEqual({ idea: [], today: [], done: [] });
  });

  it("本文が取れない .md は idea", () => {
    const columns = toColumns([file("バイナリ.md", null)]);

    expect(columns.idea).toEqual(["バイナリ"]);
  });

  it("ファイル名の途中の .md はタイトルに残す", () => {
    const columns = toColumns([file("a.md.md", "")]);

    expect(columns.idea).toEqual(["a.md"]);
  });
});
