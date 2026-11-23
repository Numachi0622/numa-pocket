import { describe, expect, it } from "vitest";
import { parseColumnWidth } from "./layout";

describe("PC の列幅", () => {
  it.each(["160", "320", "800", " 400 "])("%s pxを設定できる", (raw) => {
    expect(parseColumnWidth(raw)).toBe(Number(raw));
  });

  it.each(["", " ", "159", "801", "300.5", "wide"])("不正な値 %s は保存しない", (raw) => {
    expect(parseColumnWidth(raw)).toBeNull();
  });
});
