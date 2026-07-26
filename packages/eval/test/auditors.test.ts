import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";

import { extractSpotAuditCases } from "../src/provenance/judgeSpotAudit";
import { corrupt } from "../src/provenance/calibrateAuditor";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

describe("extractSpotAuditCases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gl-audit-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("should handle empty/missing files gracefully (case 1)", () => {
    // 1. Missing scores directory throws
    expect(() => extractSpotAuditCases(tempDir)).toThrow(/No scores at/);

    // 2. Empty scores directory returns empty result
    const scoresDir = join(tempDir, "scores");
    mkdirSync(scoresDir);
    const resEmpty = extractSpotAuditCases(tempDir);
    expect(resEmpty.results).toEqual([]);
    expect(existsSync(resEmpty.reportPath)).toBe(true);

    // 3. Score file exists but missing prompt/response files
    writeFileSync(
      join(scoresDir, "001.json"),
      JSON.stringify({
        ordinal: 1,
        factAudit: [{ claim: "C1", evidence: "E1", verified: true }],
      }),
    );

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resSkipped = extractSpotAuditCases(tempDir);
    expect(resSkipped.results).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing prompt/response artifact"),
    );
    consoleErrorSpy.mockRestore();
  });

  it("should extract cases correctly in a typical single case scenario (case 2)", () => {
    const scoresDir = join(tempDir, "scores");
    const promptsDir = join(tempDir, "prompts");
    const responsesDir = join(tempDir, "responses");
    mkdirSync(scoresDir);
    mkdirSync(promptsDir);
    mkdirSync(responsesDir);

    writeFileSync(
      join(scoresDir, "001.json"),
      JSON.stringify({
        ordinal: 1,
        factAudit: [
          {
            claim: "Claim text 1",
            evidence: "Evidence text 1",
            verdict: "VERIFIED",
          },
        ],
      }),
    );

    writeFileSync(join(promptsDir, "001.txt"), "This is the prompt 1");
    writeFileSync(join(responsesDir, "001.txt"), "This is the response 1");

    const mockExec = vi.mocked(execFileSync);
    mockExec.mockReturnValueOnce("CLAIM 1: AGREE - Correctly matched.\nAGREEMENT: 1/1");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = extractSpotAuditCases(tempDir);

    expect(res.results).toEqual([
      {
        ordinal: "001",
        agreed: 1,
        total: 1,
        detail: "CLAIM 1: AGREE - Correctly matched.\nAGREEMENT: 1/1",
      },
    ]);

    expect(res.report).toContain("# Judge Spot-Audit Report");
    expect(res.report).toContain("- Sampled: 001.json");
    expect(res.report).toContain("Agreement: 1/1 fact-audit claims");
    expect(res.report).toContain("## Ordinal 001 — 1/1");
    expect(res.report).toContain("CLAIM 1: AGREE - Correctly matched.\nAGREEMENT: 1/1");

    expect(existsSync(res.reportPath)).toBe(true);
    const savedReportContent = readFileSync(res.reportPath, "utf8");
    expect(savedReportContent).toBe(res.report);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const args = mockExec.mock.calls[0];
    expect(args).toBeDefined();
    if (args) {
      expect(args[0]).toBe("node");
      const cmdArgs = args[1] as string[];
      expect(cmdArgs).toContain("ask");
      expect(cmdArgs[6]).toContain("Independently re-check");
      expect(cmdArgs[6]).toContain('verified=true): "Claim text 1"');
    }

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("should sample score files evenly and deterministically (case 3)", () => {
    const scoresDir = join(tempDir, "scores");
    const promptsDir = join(tempDir, "prompts");
    const responsesDir = join(tempDir, "responses");
    mkdirSync(scoresDir);
    mkdirSync(promptsDir);
    mkdirSync(responsesDir);

    for (let i = 1; i <= 6; i++) {
      const ord = String(i).padStart(3, "0");
      writeFileSync(
        join(scoresDir, `${ord}.json`),
        JSON.stringify({
          ordinal: i,
          factAudit: [{ claim: `Claim ${i}`, evidence: `Evidence ${i}`, verified: true }],
        }),
      );
      writeFileSync(join(promptsDir, `${ord}.txt`), `Prompt ${i}`);
      writeFileSync(join(responsesDir, `${ord}.txt`), `Response ${i}`);
    }

    const mockExec = vi.mocked(execFileSync);
    mockExec.mockReturnValue("CLAIM 1: AGREE\nAGREEMENT: 1/1");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = extractSpotAuditCases(tempDir, { count: 3 });

    // Since count is 3, step is floor(6/3) = 2.
    // Index 0 (001), 2 (003), 4 (005) should be sampled.
    expect(res.results).toHaveLength(3);
    expect(res.results[0].ordinal).toBe("001");
    expect(res.results[1].ordinal).toBe("003");
    expect(res.results[2].ordinal).toBe("005");
    expect(mockExec).toHaveBeenCalledTimes(3);

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("should handle error cases and malformed/missing fields gracefully (case 4)", () => {
    const scoresDir = join(tempDir, "scores");
    const promptsDir = join(tempDir, "prompts");
    const responsesDir = join(tempDir, "responses");
    mkdirSync(scoresDir);
    mkdirSync(promptsDir);
    mkdirSync(responsesDir);

    // 1. Missing factAudit and missing ordinal (ordinal falls back to filename)
    writeFileSync(
      join(scoresDir, "001.json"),
      JSON.stringify({
        // empty JSON to test fallback
      }),
    );
    writeFileSync(join(promptsDir, "001.txt"), "Prompt 1");
    writeFileSync(join(responsesDir, "001.txt"), "Response 1");

    // 2. execFileSync throws (agy run failed)
    writeFileSync(
      join(scoresDir, "002.json"),
      JSON.stringify({
        ordinal: 2,
        factAudit: [{ claim: "C2", evidence: "E2", verified: false }],
      }),
    );
    writeFileSync(join(promptsDir, "002.txt"), "Prompt 2");
    writeFileSync(join(responsesDir, "002.txt"), "Response 2");

    const mockExec = vi.mocked(execFileSync);
    // Set a default mock return value so fallback calls do not return undefined
    mockExec.mockReturnValue("CLAIM 1: AGREE\nAGREEMENT: 1/1");
    // For 001, return success
    mockExec.mockReturnValueOnce("CLAIM 1: AGREE\nAGREEMENT: 1/1");
    // For 002, throw error
    mockExec.mockImplementationOnce(() => {
      const err = new Error("Agy failed");
      (err as { status?: number }).status = 127;
      throw err;
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = extractSpotAuditCases(tempDir, { count: 2 });

    expect(res.results).toHaveLength(2);
    // 001 checks out: ordinal fell back to "001" derived from filename
    expect(res.results[0].ordinal).toBe("001");
    expect(res.results[0].agreed).toBe(1);
    expect(res.results[0].total).toBe(1);

    // 002 checks out: failed run recorded as null/UNAVAILABLE
    expect(res.results[1].ordinal).toBe("002");
    expect(res.results[1].agreed).toBeNull();
    expect(res.results[1].total).toBeNull();
    expect(res.results[1].detail).toBe("agy transport failure");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("agy run failed (127)"),
    );

    // 3. Corrupted JSON file (should propagate JSON parsing error)
    writeFileSync(join(scoresDir, "003.json"), "invalid json data {");
    writeFileSync(join(promptsDir, "003.txt"), "Prompt 3");
    writeFileSync(join(responsesDir, "003.txt"), "Response 3");

    // Re-run should throw SyntaxError
    expect(() => extractSpotAuditCases(tempDir, { count: 3 })).toThrow(SyntaxError);

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});

describe("calibrateAuditor corrupt pure function", () => {
  describe("timeShift", () => {
    it("should shift the first timestamp by 1 minute with correct note when type is timeShift", () => {
      const r1 = corrupt("HP dropped at 1:22", "timeShift");
      expect(r1.text).toBe("HP dropped at 2:22");
      expect(r1.note).toBe("timestamp 1:22 -> 2:22");

      const r2 = corrupt("Stun landed at 10:45 on healer", "timeShift");
      expect(r2.text).toBe("Stun landed at 11:45 on healer");
      expect(r2.note).toBe("timestamp 10:45 -> 11:45");
    });

    it("should fallback to shifted timestamp note when type is not timeShift", () => {
      const r1 = corrupt("HP dropped at 1:22", "numberDistort");
      expect(r1.text).toBe("HP dropped at 2:22");
      expect(r1.note).toBe("timestamp 1:22 shifted");

      const r2 = corrupt("Stun landed at 10:45 on healer", "otherType");
      expect(r2.text).toBe("Stun landed at 11:45 on healer");
      expect(r2.note).toBe("timestamp 10:45 shifted");
    });
  });

  describe("numberDistort", () => {
    it("should distort 'k' suffix numbers and leave other text untouched", () => {
      const r1 = corrupt("He has 10k gold", "numberDistort");
      expect(r1.text).toBe("He has 910k gold");
      expect(r1.note).toBe("10k -> 910k");

      const r2 = corrupt("DPS of 105k is quite high", "numberDistort");
      expect(r2.text).toBe("DPS of 9105k is quite high");
      expect(r2.note).toBe("105k -> 9105k");
    });

    it("should distort '%' suffix numbers and leave other text untouched", () => {
      const r1 = corrupt("Win rate is 50%", "numberDistort");
      expect(r1.text).toBe("Win rate is 950%");
      expect(r1.note).toBe("50% -> 950%");

      const r2 = corrupt("Accuracy was 9%', not bad", "numberDistort");
      expect(r2.text).toBe("Accuracy was 99%', not bad");
      expect(r2.note).toBe("9% -> 99%");
    });
  });

  describe("semanticNegationFallback", () => {
    it("should fallback to semantic negation for text-only claims", () => {
      const r1 = corrupt("He is a good coach", "timeShift");
      expect(r1.text).toBe("No evidence exists that He is a good coach");
      expect(r1.note).toBe("text-only claim: semantic negation fallback");

      const r2 = corrupt("She won the game", "numberDistort");
      expect(r2.text).toBe("No evidence exists that She won the game");
      expect(r2.note).toBe("text-only claim: semantic negation fallback");
    });
  });
});
