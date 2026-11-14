import { describe, expect, it } from "vitest";
import type { FolderEntry } from "./github";
import { groupByColumn, readRawStatus, readStatus, toTasks, type Task } from "./parse";

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

describe("readRawStatus", () => {
  it("引用符と行末コメントを除いた値を返す", () => {
    expect(readRawStatus('---\nstatus: "wip" # メモ\n---')).toBe("wip");
  });

  it("status が無ければ null", () => {
    expect(readRawStatus("---\ntags: []\n---")).toBeNull();
  });

  it("frontmatter が無ければ null", () => {
    expect(readRawStatus("本文だけ")).toBeNull();
  });
});

function titlesByColumn(tasks: Task[]): Record<string, string[]> {
  const columns = groupByColumn(tasks);

  return {
    idea: columns.idea.map((task) => task.title),
    today: columns.today.map((task) => task.title),
    done: columns.done.map((task) => task.title),
  };
}

describe("toTasks", () => {
  it("status ごとに振り分け、タイトルはファイル名から .md を除いたもの", () => {
    const tasks = toTasks(
      [
        file("牛乳を買う.md", "---\nstatus: today\n---"),
        file("アイデア.md", "本文だけ"),
        file("終わった.md", "---\nstatus: done\n---"),
        file("作業中.md", "---\nstatus: wip\n---"),
      ],
      "Task/Data",
    );

    expect(titlesByColumn(tasks)).toEqual({
      idea: ["アイデア", "作業中"],
      today: ["牛乳を買う"],
      done: ["終わった"],
    });
  });

  it("パス・本文・元の status 値を持つ", () => {
    const [task] = toTasks([file("作業中.md", "---\nstatus: wip\n---")], "Task/Data");

    expect(task).toEqual({
      name: "作業中.md",
      title: "作業中",
      path: "Task/Data/作業中.md",
      text: "---\nstatus: wip\n---",
      column: "idea",
      rawStatus: "wip",
    });
  });

  it("サブフォルダは無視する", () => {
    expect(toTasks([{ name: "archive.md", type: "tree", text: null }], "f")).toEqual([]);
  });

  it(".md 以外のファイルは無視する", () => {
    expect(toTasks([file("image.png", null), file("memo.txt", "---\nstatus: today\n---"), file("README", "")], "f")).toEqual([]);
  });

  it("拡張子は大文字小文字を区別し、.MD は無視する", () => {
    expect(toTasks([file("大文字.MD", "---\nstatus: today\n---")], "f")).toEqual([]);
  });

  it("本文が取れない .md は idea で、元の status 値は null", () => {
    const [task] = toTasks([file("バイナリ.md", null)], "f");

    expect(task.column).toBe("idea");
    expect(task.rawStatus).toBeNull();
  });

  it("ファイル名の途中の .md はタイトルに残す", () => {
    const [task] = toTasks([file("a.md.md", "")], "f");

    expect(task.title).toBe("a.md");
  });
});

describe("groupByColumn", () => {
  it("columnOf を渡すと、その列で振り分ける", () => {
    const tasks = toTasks([file("a.md", "---\nstatus: today\n---"), file("b.md", "")], "f");
    const columns = groupByColumn(tasks, (task) => (task.name === "a.md" ? "done" : task.column));

    expect(columns.done.map((task) => task.name)).toEqual(["a.md"]);
    expect(columns.today).toEqual([]);
    expect(columns.idea.map((task) => task.name)).toEqual(["b.md"]);
  });
});
