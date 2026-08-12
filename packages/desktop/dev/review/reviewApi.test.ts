import { describe, expect, it } from "vitest";
import { handleReviewRequest } from "./reviewApi";

function memIo(files: Record<string, string> = {}) {
  return {
    files,
    readFile: (p: string) => files[p] ?? null,
    writeFileAtomic: (p: string, d: string) => {
      files[p] = d;
    },
    listDir: (p: string) =>
      Object.keys(files)
        .filter((f) => f.startsWith(p))
        .map((f) => f.slice(p.length + 1)),
  };
}

describe("handleReviewRequest", () => {
  it("answers roundtrip: POST then GET returns the same doc", () => {
    const io = memIo();
    const doc = JSON.stringify({ schemaVersion: 1, name: "exp1", answers: [] });
    expect(
      handleReviewRequest(
        { method: "POST", url: "/__review/answers/exp1", body: doc },
        io,
      ).status,
    ).toBe(200);
    const got = handleReviewRequest(
      { method: "GET", url: "/__review/answers/exp1", body: "" },
      io,
    );
    expect(JSON.parse(got.body)).toEqual(JSON.parse(doc));
  });
  it("missing session is 404", () => {
    expect(
      handleReviewRequest(
        { method: "GET", url: "/__review/session/nope", body: "" },
        memIo(),
      ).status,
    ).toBe(404);
  });
  it("path traversal name is 400", () => {
    expect(
      handleReviewRequest(
        { method: "GET", url: "/__review/session/..%2Fx", body: "" },
        memIo(),
      ).status,
    ).toBe(400);
  });
});
