import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./blob-sha";

// 期待値は `printf ... | git hash-object --stdin` で求めた。
describe("gitBlobSha", () => {
  it.each([
    ["LF の 1 行", "hello\n", "ce013625030ba8dba906f756967f9e9ca394464a"],
    ["空", "", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
    ["BOM・CRLF・日本語", "﻿---\r\nstatus: today\r\n---\r\n日本語\r\n", "0a3048d0ff54db54336db69433a3b10b536f3ff0"],
  ])("%s", async (_, text, sha) => {
    expect(await gitBlobSha(text)).toBe(sha);
  });

  it("BOM を落とした本文は元のファイルと一致しない", async () => {
    expect(await gitBlobSha("---\r\nstatus: today\r\n---\r\n日本語\r\n")).not.toBe("0a3048d0ff54db54336db69433a3b10b536f3ff0");
  });
});
