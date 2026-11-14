import { describe, expect, it } from "vitest";
import { withStatus } from "./frontmatter";
import { readStatus } from "./parse";

describe("withStatus", () => {
  it.each([
    ["(1) status だけ", "---\nstatus: today\n---\n", "---\nstatus: done\n---\n"],
    [
      "(2) 本文と status 以外のキー",
      "---\ncreated: 2026-11-14\nstatus: today\ntags: [a]\n---\n本文\n\n- 箇条書き\n",
      "---\ncreated: 2026-11-14\nstatus: done\ntags: [a]\n---\n本文\n\n- 箇条書き\n",
    ],
    ["(3) frontmatter 無し", "本文だけ\n", "---\nstatus: done\n---\n本文だけ\n"],
    ["(3) 空のファイル", "", "---\nstatus: done\n---\n"],
    ["(4) status 無しの frontmatter", "---\ncreated: 2026-11-14\n---\n本文\n", "---\ncreated: 2026-11-14\nstatus: done\n---\n本文\n"],
    ["(4) 空の frontmatter", "---\n---\n", "---\nstatus: done\n---\n"],
    ["(5) 想定外の値", "---\nstatus: wip\n---\n", "---\nstatus: done\n---\n"],
    ["(6) CRLF", "---\r\nstatus: today\r\n---\r\n本文\r\n", "---\r\nstatus: done\r\n---\r\n本文\r\n"],
    ["(6) CRLF で frontmatter 無し", "本文\r\n", "---\r\nstatus: done\r\n---\r\n本文\r\n"],
    ["(6) CRLF で status 無し", "---\r\na: 1\r\n---\r\n", "---\r\na: 1\r\nstatus: done\r\n---\r\n"],
    ["BOM 付き", "﻿---\nstatus: today\n---\n", "﻿---\nstatus: done\n---\n"],
    ["BOM 付きで frontmatter 無し", "﻿本文\n", "﻿---\nstatus: done\n---\n本文\n"],
    ["引用符付き", '---\nstatus: "today"\n---\n', "---\nstatus: done\n---\n"],
    ["引用符付きと行末コメント", '---\nstatus: "today" # 今日\n---\n', "---\nstatus: done # 今日\n---\n"],
    ["行末コメント", "---\nstatus: today  # 今日\n---\n", "---\nstatus: done  # 今日\n---\n"],
    ["値の中の # はコメントではない", "---\nstatus: to#day\n---\n", "---\nstatus: done\n---\n"],
    ["値が空", "---\nstatus:\n---\n", "---\nstatus: done\n---\n"],
    ["閉じの --- が無い", "---\nstatus: today\n本文\n", "---\nstatus: done\n---\n---\nstatus: today\n本文\n"],
    ["インデントされた status は対象外", "---\nmeta:\n  status: today\n---\n", "---\nmeta:\n  status: today\nstatus: done\n---\n"],
    ["本文中の status は変えない", "---\na: 1\n---\nstatus: today\n", "---\na: 1\nstatus: done\n---\nstatus: today\n"],
    ["最後に改行が無い", "---\nstatus: today\n---", "---\nstatus: done\n---"],
  ])("%s", (_, before, after) => {
    const result = withStatus(before, "done");

    expect(result).toBe(after);
    expect(readStatus(result)).toBe("done");
  });

  it("status の行が複数あれば最初の行だけを変える（readStatus も最初の行を読む）", () => {
    const result = withStatus("---\nstatus: today\nstatus: idea\n---\n", "done");

    expect(result).toBe("---\nstatus: done\nstatus: idea\n---\n");
    expect(readStatus(result)).toBe("done");
  });

  it("行ごとに改行コードが混ざっていても、他の行の改行は変えない", () => {
    expect(withStatus("---\r\nstatus: today\n---\r\n本文\n", "idea")).toBe("---\r\nstatus: idea\n---\r\n本文\n");
  });
});
