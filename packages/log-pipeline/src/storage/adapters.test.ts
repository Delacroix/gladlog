import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeStorageAdapterContract } from "./adapterContract";
import { LocalDirStorageAdapter } from "./LocalDirStorageAdapter";
import { MemoryStorageAdapter } from "./MemoryStorageAdapter";

describeStorageAdapterContract(
  "MemoryStorageAdapter",
  async () => new MemoryStorageAdapter(),
);

describeStorageAdapterContract(
  "LocalDirStorageAdapter",
  async () =>
    new LocalDirStorageAdapter(mkdtempSync(join(tmpdir(), "lp-adapter-"))),
);

describe("LocalDirStorageAdapter.diagnose", () => {
  it("has nothing to say about an ordinary fully-present file", async () => {
    // The positive case (a Drive `dataless` placeholder) cannot be manufactured
    // in a test; this pins the negative so a healthy file never gets blamed.
    const root = mkdtempSync(join(tmpdir(), "lp-diag-"));
    writeFileSync(join(root, "raw"), "not a placeholder");
    const a = new LocalDirStorageAdapter(root);
    expect(await a.diagnose("raw")).toBeUndefined();
  });
});
