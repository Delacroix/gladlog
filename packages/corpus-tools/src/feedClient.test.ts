import { describe, expect, it, vi } from "vitest";

import {
  downloadRaw,
  fetchMatchStubs,
  fetchWithRetry,
  USER_AGENT,
  withUserAgent,
} from "./feedClient";

describe("fetchMatchStubs", () => {
  it("POSTs minRating as a server-side variable and maps combats to MatchStub[]", async () => {
    // The server already filtered by minRating, so the fake only returns combats
    // at or above the threshold; the client only maps and never filters again.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          latestMatches: {
            combats: [
              { id: "a", logObjectUrl: "u1", startTime: 1, endTime: 2 },
              { id: "b", logObjectUrl: "u2", startTime: 3, endTime: 4 },
            ],
          },
        },
      }),
    });
    const stubs = await fetchMatchStubs(
      { bracket: "3v3", minRating: 2300, limit: 10 },
      fakeFetch as any,
    );
    expect(stubs.map((s) => s.id)).toEqual(["a", "b"]);
    expect(stubs[0].logObjectUrl).toBe("u1");
    // Assert minRating really goes out as a GraphQL variable (server-side filtering)
    const body = JSON.parse((fakeFetch.mock.calls[0][1] as any).body);
    expect(body.variables.minRating).toBe(2300);
    expect(body.variables.bracket).toBe("3v3");
  });
  it("retries transient 503s then succeeds (production runs must survive feed blips)", async () => {
    let calls = 0;
    const flaky = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          data: {
            latestMatches: { combats: [{ id: "a", logObjectUrl: "u1" }] },
          },
        }),
      };
    });
    const res = await fetchWithRetry(flaky as any, "url", {}, "feed", {
      baseDelayMs: 1,
    });
    expect(calls).toBe(3);
    const body = await res.json();
    expect(body.data.latestMatches.combats[0].id).toBe("a");
  });
  it("throws immediately on a non-retryable 4xx (no wasted retries)", async () => {
    const badReq = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    await expect(
      fetchWithRetry(badReq as any, "url", {}, "feed", { baseDelayMs: 1 }),
    ).rejects.toThrow(/HTTP 400/);
    expect(badReq).toHaveBeenCalledTimes(1);
  });
  it("gives up after exhausting retries on persistent 5xx", async () => {
    const down = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(
      fetchWithRetry(down as any, "url", {}, "feed", {
        retries: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(down).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
  // Outbound identity: they are a volunteer project, and a bare UA makes us
  // indistinguishable from any crawler in their logs. These cases guard "every
  // outbound request carries it", not "what the constant looks like".
  it("sends the identifying User-Agent on feed requests", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { latestMatches: { combats: [] } } }),
    });
    await fetchMatchStubs(
      { bracket: "3v3", minRating: 2100, limit: 10 },
      fakeFetch as any,
    );
    const init = fakeFetch.mock.calls[0][1] as any;
    expect(init.headers["user-agent"]).toBe(USER_AGENT);
    // The UA must not evict the caller's own headers
    expect(init.headers["content-type"]).toBe("application/json");
  });
  it("sends the User-Agent even when the caller passes no init (bare GCS GET)", async () => {
    // Log downloads go through fetchWithRetry(f, url, undefined, ...) — the path
    // most likely to drop the UA.
    const fakeFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchWithRetry(
      fakeFetch as any,
      "https://storage.googleapis.com/x/m1",
      undefined,
      "log download",
    );
    const init = fakeFetch.mock.calls[0][1] as any;
    expect(init.headers["user-agent"]).toBe(USER_AGENT);
  });
  it("USER_AGENT carries a contact URL so the operator can reach us", () => {
    // A tool name without contact details is as good as nothing: they need
    // somewhere to reach us if they want us throttled or stopped.
    expect(USER_AGENT).toMatch(/https?:\/\/\S+/);
  });
  it("withUserAgent preserves caller headers and init fields", () => {
    const out = withUserAgent({ method: "POST", headers: { a: "1" } });
    expect(out.method).toBe("POST");
    expect(out.headers.a).toBe("1");
    expect(out.headers["user-agent"]).toBe(USER_AGENT);
  });
  it("stops paging when the feed returns an empty page", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { latestMatches: { combats: [] } } }),
    });
    const stubs = await fetchMatchStubs(
      { bracket: "2v2", minRating: 2300, limit: 10 },
      fakeFetch as any,
    );
    expect(stubs).toEqual([]);
  });
});

describe("downloadRaw(不解压,原始字节)", () => {
  it("以 compress:false 请求并返回未解压字节与 content-length", async () => {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
    const fake = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (k: string) =>
          ({
            "content-length": String(body.length),
            "content-encoding": "gzip",
          })[k.toLowerCase()] ?? null,
      },
      arrayBuffer: async () => body.buffer.slice(0, body.length),
      json: async () => ({}),
    });
    const raw = await downloadRaw("https://x/y", "probe", fake as any);
    // compress:false is the crux — otherwise node-fetch decompresses automatically
    // and the raw bytes are lost
    expect(fake.mock.calls[0][1].compress).toBe(false);
    expect(raw.bytes.length).toBe(body.length);
    expect(raw.contentEncoding).toBe("gzip");
    expect(raw.expectedBytes).toBe(body.length);
    // The UA must still be attached (the single-choke-point constraint)
    expect(fake.mock.calls[0][1].headers["user-agent"]).toBe(USER_AGENT);
  });

  // Regression case caught by real-machine verification on 2026-08-01: node-fetch
  // only adds Accept-Encoding: gzip automatically when compress is true; with
  // compress:false and no explicit header, GCS server-side transcodes gzip-stored
  // objects (sends them decompressed, drops content-length) while
  // x-goog-stored-content-length still reports the compressed size — replaying
  // the exact byte-mismatch bug shaped like c9c463e. Both halves are required:
  // explicitly ask for a compressed response, and do not decompress on the client.
  it("显式声明 Accept-Encoding: gzip,防止 GCS 服务端转码吐出解压字节", async () => {
    const fake = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({}),
    });
    await downloadRaw("https://x/y", "probe", fake as any);
    expect(fake.mock.calls[0][1].headers["accept-encoding"]).toBe("gzip");
  });
});
