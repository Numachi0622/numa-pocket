import { describe, expect, it } from "vitest";
import { isSameName, validateRename, validateTitle } from "./task-title";

describe("validateTitle", () => {
  it("前後の空白を除いて、ファイル名を付けて返す", () => {
    expect(validateTitle("  牛乳を買う ", [])).toEqual({ ok: true, title: "牛乳を買う", name: "牛乳を買う.md" });
  });

  it("空・空白だけは理由を出さずに弾く", () => {
    expect(validateTitle("", [])).toEqual({ ok: false, reason: null });
    expect(validateTitle("   ", [])).toEqual({ ok: false, reason: null });
  });

  it.each(["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "#tag", "a^b", "[[a]]"])("%s は使えない文字として弾く", (title) => {
    const check = validateTitle(title, []);

    expect(check.ok).toBe(false);
    expect(check.ok ? null : check.reason).toContain("使えない文字");
  });

  it("「.」で始まる・終わるタイトルは弾く", () => {
    expect(validateTitle(".hidden", []).ok).toBe(false);
    expect(validateTitle("おわり.", []).ok).toBe(false);
    expect(validateTitle("v1.2 を出す", []).ok).toBe(true);
  });

  it("ファイル名が UTF-8 で 255 バイトを超えたら弾く", () => {
    expect(validateTitle("あ".repeat(84), []).ok).toBe(true);
    expect(validateTitle("あ".repeat(85), []).ok).toBe(false);
  });

  it("大文字・小文字や正規化の違いだけの同じ名前は弾く", () => {
    expect(validateTitle("Report", ["report.md"])).toEqual({ ok: false, reason: "同じ名前のタスクがあります" });
    expect(validateTitle("が", ["が.md"]).ok).toBe(false);
    expect(validateTitle("Report 2", ["report.md"]).ok).toBe(true);
  });
});

describe("isSameName", () => {
  it("大文字・小文字と正規化の違いを無視する", () => {
    expect(isSameName("A.md", "a.md")).toBe(true);
    expect(isSameName("が.md", "が.md")).toBe(true);
    expect(isSameName("a.md", "b.md")).toBe(false);
  });
});

describe("validateRename", () => {
  it("自分自身とは重複扱いせず、他のタスクとの重複は弾く", () => {
    expect(validateRename("豆乳", "牛乳.md", ["牛乳.md", "卵.md"])).toEqual({ ok: true, title: "豆乳", name: "豆乳.md" });
    expect(validateRename("卵", "牛乳.md", ["牛乳.md", "卵.md"])).toEqual({ ok: false, reason: "同じ名前のタスクがあります" });
  });

  it("大文字・小文字だけの変更は弾く", () => {
    expect(validateRename("Milk", "milk.md", ["milk.md"])).toEqual({ ok: false, reason: "大文字・小文字だけの変更はできません" });
  });

  it("validateTitle と同じく、空・使えない文字を弾く", () => {
    expect(validateRename("  ", "a.md", ["a.md"])).toEqual({ ok: false, reason: null });
    expect(validateRename("a/b", "a.md", ["a.md"]).ok).toBe(false);
  });
});
