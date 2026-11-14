import { describe, expect, it } from "vitest";
import { DEFAULT_DRAG_TUNING, parseDragTuning } from "./drag-tuning";

const valid = { longPressMs: "250", moveTolerancePx: "10", edgeZonePx: "48", edgeDwellMs: "400" };

describe("parseDragTuning", () => {
  it("範囲内の整数なら数値にして返す", () => {
    expect(parseDragTuning(valid)).toEqual({
      tuning: { longPressMs: 250, moveTolerancePx: 10, edgeZonePx: 48, edgeDwellMs: 400 },
      errors: [],
    });
  });

  it("前後の空白は無視する", () => {
    expect(parseDragTuning({ ...valid, longPressMs: " 300 " }).tuning?.longPressMs).toBe(300);
  });

  it("範囲の端の値は受け付ける", () => {
    expect(parseDragTuning({ ...valid, longPressMs: "50", edgeDwellMs: "0" }).errors).toEqual([]);
  });

  it.each([
    ["空", ""],
    ["小数", "200.5"],
    ["数字でない", "abc"],
    ["下限より小さい", "49"],
    ["上限より大きい", "1501"],
  ])("%s なら null とその項目のエラーを返す", (_, longPressMs) => {
    const result = parseDragTuning({ ...valid, longPressMs });

    expect(result.tuning).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("長押しの時間");
  });

  it("不正な項目がいくつあっても、すべてをエラーに入れる", () => {
    expect(parseDragTuning({ longPressMs: "", moveTolerancePx: "x", edgeZonePx: "0", edgeDwellMs: "-1" }).errors).toHaveLength(4);
  });

  it("初期値はすべて範囲内", () => {
    const asText = Object.fromEntries(Object.entries(DEFAULT_DRAG_TUNING).map(([key, value]) => [key, String(value)]));

    expect(parseDragTuning(asText as typeof valid).tuning).toEqual(DEFAULT_DRAG_TUNING);
  });
});
