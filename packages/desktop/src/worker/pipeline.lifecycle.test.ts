import { appendFileSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { FilePipeline } from "./pipeline";
import type { WorkerToMain } from "../shared/protocol";

function line(i: number, s: string): string {
  return `6/30/2026 12:00:${String(i).padStart(2, "0")}.000  ${s}\n`;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-pipeline-"));
  const file = join(dir, "WoWCombatLog.txt");
  writeFileSync(file, "");
  const msgs: WorkerToMain[] = [];
  const p = new FilePipeline({
    fileKey: "WoWCombatLog.txt",
    filePath: file,
    checkpoint: null,
    emit: (m) => msgs.push(m),
  });
  return { file, msgs, p };
}

describe("pipeline lifecycle forwarding", () => {
  it("START → segmentOpen;END → segmentClose(带 fileKey)", () => {
    const { file, msgs, p } = setup();
    appendFileSync(file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.processFlush();
    const open = msgs.find((m) => m.type === "segmentOpen");
    expect(open).toMatchObject({ fileKey: "WoWCombatLog.txt", bracket: "3v3" });
    appendFileSync(file, line(1, "ARENA_MATCH_END,1,30,1500,1501"));
    p.processFlush();
    const close = msgs.find((m) => m.type === "segmentClose");
    expect(close).toMatchObject({ aborted: false });
  });

  it("对局中文件轮转 → 合成 aborted close", () => {
    const { file, msgs, p } = setup();
    appendFileSync(file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.processFlush();
    // 轮转:整文件被替换(首行 checksum 变)
    writeFileSync(file, line(0, "ARENA_MATCH_START,1504,40,2v2,1"));
    p.processFlush();
    const closes = msgs.filter((m) => m.type === "segmentClose");
    expect(closes).toEqual([
      expect.objectContaining({ endTime: null, aborted: true }),
    ]);
    // 新 parser 的新对局照常 open
    expect(msgs.filter((m) => m.type === "segmentOpen")).toHaveLength(2);
  });
});
