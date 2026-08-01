import { describe, expect, it, vi } from "vitest";

import {
  fetchMatchStubs,
  fetchWithRetry,
  USER_AGENT,
  withUserAgent,
} from "./feedClient";

describe("fetchMatchStubs", () => {
  it("POSTs minRating as a server-side variable and maps combats to MatchStub[]", async () => {
    // 服务端已按 minRating 过滤,fake 只返回 >= 门槛的 combats;客户端只做映射,不再二次过滤。
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
    // 断言 minRating 确实作为 GraphQL 变量下发(服务端过滤)
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
  // 出站身份标识:对方是志愿者项目,裸 UA 让我们在他们日志里跟任意爬虫无法区分。
  // 这几条守的是「每一个出站请求都带得上」,不是「常量长什么样」。
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
    // UA 不能挤掉调用方本来的头
    expect(init.headers["content-type"]).toBe("application/json");
  });
  it("sends the User-Agent even when the caller passes no init (bare GCS GET)", async () => {
    // log 下载走 fetchWithRetry(f, url, undefined, ...) —— 这条路径最容易漏掉 UA。
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
    // 只带工具名不带联系方式等于没带:对方要降频/停用我们时得有地方找人。
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
