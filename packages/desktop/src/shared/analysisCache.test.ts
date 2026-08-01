import { describe, expect, it } from "vitest";
import {
  resolveActiveSlot,
  slotKeyOf,
  toSlottedDoc,
  upsertSlot,
} from "./analysisCache";

const R = (n: number) => ({ findings: [], dropped: n, hadNarration: true });

describe("slotted analysis cache", () => {
  it("v1 旧单结果懒迁移成单槽,legacySlotKey 归属", () => {
    const v1 = {
      schemaVersion: 1,
      promptVersion: 13,
      language: "zh",
      createdAt: 5,
      result: R(1),
    };
    const doc = toSlottedDoc(v1, "anthropic:claude-sonnet-5")!;
    expect(doc.schemaVersion).toBe(2);
    expect(doc.lastSlotKey).toBe("anthropic:claude-sonnet-5");
    expect(doc.slots["anthropic:claude-sonnet-5"]).toEqual({
      promptVersion: 13,
      createdAt: 5,
      result: R(1),
    });
  });
  it("v2 原样通过;垃圾/缺 slots 返回 null", () => {
    const v2 = {
      schemaVersion: 2,
      language: "zh",
      slots: { "a:b": { promptVersion: 13, createdAt: 1, result: R(2) } },
      lastSlotKey: "a:b",
    };
    expect(toSlottedDoc(v2, "x:y")).toEqual(v2);
    expect(toSlottedDoc(null, "x:y")).toBeNull();
    expect(toSlottedDoc({ schemaVersion: 2 }, "x:y")).toBeNull();
  });
  it("upsertSlot 只动目标槽与 lastSlotKey,他槽字节不动", () => {
    const base = upsertSlot(null, "zh", "a:m1", R(1), 10);
    const two = upsertSlot(base, "zh", "b:m2", R(2), 20);
    expect(Object.keys(two.slots).sort()).toEqual(["a:m1", "b:m2"]);
    expect(two.lastSlotKey).toBe("b:m2");
    expect(two.slots["a:m1"]).toBe(base.slots["a:m1"]); // 引用不变=未重建
    const over = upsertSlot(two, "zh", "a:m1", R(3), 30);
    expect(over.slots["a:m1"].result).toEqual(R(3));
    expect(over.slots["b:m2"]).toBe(two.slots["b:m2"]);
  });
  it("resolveActiveSlot 走 lastSlotKey;悬空键返回 null", () => {
    const doc = upsertSlot(
      upsertSlot(null, "zh", "a:m1", R(1), 1),
      "zh",
      "b:m2",
      R(2),
      2,
    );
    expect(resolveActiveSlot(doc)!.result).toEqual(R(2));
    expect(resolveActiveSlot({ ...doc, lastSlotKey: "ghost:x" })).toBeNull();
    expect(resolveActiveSlot(null)).toBeNull();
  });
  it("slotKeyOf 拼接", () =>
    expect(slotKeyOf("deepseek", "deepseek-chat")).toBe(
      "deepseek:deepseek-chat",
    ));
});
