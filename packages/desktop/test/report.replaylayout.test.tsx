// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";

import { useReplayLayout } from "../src/renderer/src/report/components/useReplayLayout";

// The local jsdom has no localStorage while CI's does — install an in-memory
// shim when it is missing so both environments exercise the same code path
// (precedent: report.replaysplit.test).
function ensureLocalStorage(): void {
  if (globalThis.localStorage) return;
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  });
}

beforeEach(() => {
  ensureLocalStorage();
  globalThis.localStorage.clear();
});

describe("gcdCompact 持久化(P1-6)", () => {
  it("默认 false;set 后写进 localStorage,重挂载读回;脏数据落回 false", () => {
    const { result, unmount } = renderHook(() => useReplayLayout());
    expect(result.current.gcdCompact).toBe(false);
    act(() => result.current.setGcdCompact(true));
    expect(result.current.gcdCompact).toBe(true);
    unmount();
    const again = renderHook(() => useReplayLayout());
    expect(again.result.current.gcdCompact).toBe(true);
    localStorage.setItem(
      "gladlog.replaySplit",
      JSON.stringify({ mode: "split", gcdCompact: "yes" }),
    );
    const dirty = renderHook(() => useReplayLayout());
    expect(dirty.result.current.gcdCompact).toBe(false);
  });
});
