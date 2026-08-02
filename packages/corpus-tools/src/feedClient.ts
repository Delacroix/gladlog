import { gunzipSync } from "node:zlib";

export interface MatchStub {
  id: string;
  bracket: string;
  rating: number;
  logObjectUrl: string;
}

const FEED_ENDPOINT = "https://wowarenalogs.com/api/graphql";
// The real query (taken from fetchStubs in the old CLEAN fork; proven by a
// go/no-go smoke test). minRating is a **server-side** variable — the returned
// combats are already rating-filtered, so the client must not filter by rating
// again. `combats` is the interface type CombatDataStub, so fields must be
// selected through `... on ArenaMatchDataStub` / `... on ShuffleRoundStub`
// inline fragments (selecting fields directly returns 400).
const STUBS_QUERY = `query GetLatestMatches($wowVersion: String!, $bracket: String, $offset: Int!, $count: Int!, $minRating: Float) {
  latestMatches(wowVersion: $wowVersion, bracket: $bracket, offset: $offset, count: $count, minRating: $minRating) {
    combats {
      ... on ArenaMatchDataStub { id logObjectUrl startInfo { bracket } }
      ... on ShuffleRoundStub { id logObjectUrl startInfo { bracket } }
    }
  }
}`;

type FetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<any>;
  text?: () => Promise<any>;
};
type FetchLike = (url: string, init?: any) => Promise<FetchResponse>;

/**
 * Outbound identity. wowarenalogs is a **third-party volunteer project** and the
 * feed and GCS bills are theirs; bare node-fetch default headers would make us
 * indistinguishable from any random crawler in their logs — their only recourse
 * would be a blanket IP ban that also hits innocent traffic. Carrying the tool
 * name and repo URL lets them find out who we are and what we are doing at any
 * time, and gives them a way to reach us if they want us to slow down or stop.
 * Compliance rationale: docs/DATA-COMPLIANCE.md.
 */
export const USER_AGENT =
  "gladlog-corpus-tools/1.0 (+https://github.com/mingjianliu/gladlog)";

/**
 * Merge the UA into init.headers while preserving the caller's own headers. init
 * may be undefined (a bare GCS GET), in which case an init carrying the UA is
 * still constructed — this is the single source, so callers never have to
 * remember it individually.
 */
export function withUserAgent(init: any): any {
  return {
    ...(init ?? {}),
    headers: { ...((init?.headers as any) ?? {}), "user-agent": USER_AGENT },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with exponential backoff. A production corpus build makes thousands of
 * feed requests; transient 429/5xx and network blips are expected and must not
 * abort the whole run. Retries only retryable failures (429, 5xx, network
 * errors); 4xx (other than 429) throw immediately. Exposed for unit testing.
 */
export async function fetchWithRetry(
  f: FetchLike,
  url: string,
  init: any,
  label: string,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<FetchResponse> {
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  // The single outbound choke point: both feed queries and GCS log downloads go
  // through here, so attaching the UA once covers everything.
  const initWithUa = withUserAgent(init);
  let lastErr: Error = new Error(`${label}: no attempt made`);
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: FetchResponse | undefined;
    let netErr: unknown;
    try {
      res = await f(url, initWithUa);
    } catch (e) {
      netErr = e;
    }
    if (res && res.ok) return res;
    const status = res?.status;
    const retryable =
      netErr != null || status === 429 || (!!status && status >= 500);
    lastErr =
      netErr instanceof Error
        ? netErr
        : new Error(`${label} HTTP ${status ?? "?"}`);
    if (!retryable || attempt === retries) throw lastErr;
    // exponential backoff with jitter, capped
    await sleep(
      Math.min(baseDelayMs * 2 ** attempt, 15000) + Math.random() * 500,
    );
  }
  throw lastErr;
}

export async function fetchMatchStubs(
  opts: { bracket: string; minRating: number; specId?: number; limit: number },
  fetchImpl?: FetchLike,
): Promise<MatchStub[]> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const out: MatchStub[] = [];
  let offset = 0;
  const page = 50;
  while (out.length < opts.limit) {
    const res = await fetchWithRetry(
      f,
      FEED_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: STUBS_QUERY,
          variables: {
            wowVersion: "retail",
            bracket: opts.bracket,
            offset,
            count: page,
            minRating: opts.minRating, // server-side filter
          },
        }),
      },
      "feed",
    );
    const combats = (await res.json())?.data?.latestMatches?.combats ?? [];
    if (combats.length === 0) break;
    for (const c of combats) {
      // The server already filtered by minRating; the client only maps.
      out.push({
        id: c.id,
        bracket: opts.bracket,
        rating: opts.minRating,
        logObjectUrl: c.logObjectUrl,
      });
      if (out.length >= opts.limit) break;
    }
    // A short page (fewer than the requested count) means the end of the feed;
    // this avoids re-requesting the same page forever against mock or real paging.
    if (combats.length < page) break;
    offset += page;
  }
  return out;
}

export async function downloadLogText(
  stub: MatchStub,
  fetchImpl?: FetchLike,
): Promise<string> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const res = await fetchWithRetry(
    f,
    stub.logObjectUrl,
    undefined,
    `log download for ${stub.id}`,
  );
  return await (res as any).text();
}

// ── Detailed stubs (for fetch-public corpus harvesting) ────────────────────
// Same endpoint / paging / retry as STUBS_QUERY; a superset of fields:
// identifies the recorder and advanced logging.
// Note: minRating is a server-side Firestore composite-index variable and must
// be passed together with bracket (bracket:null + minRating →
// FAILED_PRECONDITION, measured 2026-07-16).

export interface DetailedStubUnit {
  id: string;
  name: string;
  spec: string;
  reaction: number;
  // Player details derived from COMBATANT_INFO; null for non-player units
  // (pets / totems).
  info?: { specId: string; personalRating: number; teamId: string } | null;
}

export interface DetailedMatchStub {
  typename: string;
  id: string;
  logObjectUrl: string;
  playerId: string;
  hasAdvancedLogging: boolean;
  durationInSeconds: number;
  bracket: string;
  units: DetailedStubUnit[];
  // Rating / time metadata (fields confirmed by introspection 2026-07-29).
  // startTime is the uploader's epoch ms.
  startTime: number;
  result: number;
  playerTeamRating: number;
  winningTeamId: string;
  playerTeamId: string;
  team0MMR: number;
  team1MMR: number;
}

// compQueryString: server-side pre-indexed team spec-composition filter (specId
// strings sorted **lexicographically** and joined with `_`, e.g. "105_263";
// subsets are indexed too, and both teams are expressed as "AxB"). Only the four
// minRating tiers 1400/1800/2100/2400 take effect, and the criterion is the
// match's average MMR — all confirmed 2026-07-29 against the wowarenalogs source
// plus real requests.
const DETAILED_STUBS_QUERY = `query GetLatestMatchesDetailed($wowVersion: String!, $bracket: String, $offset: Int!, $count: Int!, $minRating: Float, $compQueryString: String) {
  latestMatches(wowVersion: $wowVersion, bracket: $bracket, offset: $offset, count: $count, minRating: $minRating, compQueryString: $compQueryString) {
    combats {
      __typename
      ... on ArenaMatchDataStub {
        id logObjectUrl playerId hasAdvancedLogging durationInSeconds
        startTime result playerTeamRating winningTeamId playerTeamId
        startInfo { bracket }
        endInfo { team0MMR team1MMR }
        units { id name spec reaction info { specId personalRating teamId } }
      }
      ... on ShuffleRoundStub {
        id logObjectUrl playerId hasAdvancedLogging durationInSeconds
        startTime result playerTeamRating winningTeamId playerTeamId
        startInfo { bracket }
        units { id name spec reaction info { specId personalRating teamId } }
      }
    }
    queryLimitReached
  }
}`;

export async function fetchDetailedStubs(
  opts: {
    bracket?: string;
    minRating?: number;
    offset?: number;
    count?: number;
    compQueryString?: string;
  },
  fetchImpl?: FetchLike,
): Promise<{ stubs: DetailedMatchStub[]; queryLimitReached: boolean }> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  if (opts.minRating && !opts.bracket) {
    throw new Error(
      "minRating requires bracket (server-side composite index; 2026-07-16 FAILED_PRECONDITION)",
    );
  }
  const res = await fetchWithRetry(
    f,
    FEED_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: DETAILED_STUBS_QUERY,
        variables: {
          wowVersion: "retail",
          bracket: opts.bracket ?? null,
          offset: opts.offset ?? 0,
          count: opts.count ?? 50,
          minRating:
            opts.minRating && opts.minRating > 0 ? opts.minRating : null,
          compQueryString: opts.compQueryString ?? null,
        },
      }),
    },
    "feed-detailed",
  );
  const data = (await res.json())?.data?.latestMatches;
  if (!data) throw new Error("feed-detailed: empty latestMatches response");
  const stubs: DetailedMatchStub[] = (data.combats ?? []).map((c: any) => ({
    typename: c.__typename ?? "",
    id: c.id,
    logObjectUrl: c.logObjectUrl,
    playerId: c.playerId ?? "",
    hasAdvancedLogging: !!c.hasAdvancedLogging,
    durationInSeconds: c.durationInSeconds ?? 0,
    bracket: c.startInfo?.bracket ?? "",
    units: c.units ?? [],
    startTime: c.startTime ?? 0,
    result: c.result ?? 0,
    playerTeamRating: c.playerTeamRating ?? 0,
    winningTeamId: c.winningTeamId ?? "",
    playerTeamId: c.playerTeamId ?? "",
    // ShuffleRoundStub has no endInfo (the whole-match MMR lives in
    // shuffleMatchEndInfo); default to 0.
    team0MMR: c.endInfo?.team0MMR ?? 0,
    team1MMR: c.endInfo?.team1MMR ?? 0,
  }));
  return { stubs, queryLimitReached: !!data.queryLimitReached };
}

/**
 * The byte count from the GCS response headers usable for integrity checking:
 * prefer x-goog-stored-content-length (the stored object's raw size, unaffected
 * by transfer-encoding), falling back to content-length. When neither is
 * available (some proxies and test fetches do not return them) it returns
 * undefined — callers then skip the byte check, because "no header" must not be
 * mistaken for "truncated".
 *
 * Moved here from pvpLogFetch.ts: downloadRaw needs it, and feedClient cannot
 * import a value from pvpLogFetch in the other direction (pvpLogFetch already
 * imports types from feedClient, so a value import back would be a runtime
 * cycle). The original location in pvpLogFetch.ts is now a one-line re-export.
 */
export function expectedByteLength(headers: {
  contentLength?: string;
  storedContentLength?: string;
}): number | undefined {
  const raw = headers.storedContentLength || headers.contentLength;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface RawDownload {
  /** Undecompressed response body bytes. Objects on GCS are stored gzipped, so this is exactly those compressed bytes. */
  bytes: Buffer;
  /** The response's content-encoding, usually "gzip"; an empty string means uncompressed. */
  contentEncoding: string;
  /** Read a response header (lowercase name); returns an empty string when absent. */
  header(name: string): string;
  /** The byte count GCS declares (= compressed size), or undefined if unavailable. */
  expectedBytes: number | undefined;
}

/**
 * Download but **do not decompress**.
 *
 * node-fetch's default compress:true auto-gunzips, so content-length (the
 * compressed size) no longer matches the body length we get: truncation cannot
 * be verified, and we are forced to store their already-compressed data
 * decompressed (measured 11.4x inflation). compress:false stops node-fetch from
 * decompressing on the client.
 *
 * But compress:false alone is not enough — caught by real-machine verification
 * on 2026-08-01: node-fetch only adds `Accept-Encoding: gzip` automatically when
 * compress is true (see node-fetch v3 request.js `if (request.compress &&
 * !headers.has('Accept-Encoding'))`). With compress:false the request carries no
 * such header, and GCS's default behavior for gzip-stored objects is
 * **server-side transcoding**: without `Accept-Encoding: gzip` it decompresses
 * the object before sending, and the response then carries **no**
 * content-length/content-encoding (chunked) while
 * `x-goog-stored-content-length` (the compressed size) is still returned — so
 * the "expected compressed size, got decompressed byte count" mismatch replayed
 * itself at this layer, the same shape of bug as c9c463e, just moved from
 * "comparing at the text layer" to "never explicitly asking for a compressed
 * response". Hence `Accept-Encoding: gzip` must be declared explicitly so GCS
 * honestly emits compressed bytes, with compress:false keeping node-fetch from
 * unwrapping them for us on the client.
 */
export async function downloadRaw(
  url: string,
  label: string,
  fetchImpl?: FetchLike,
): Promise<RawDownload> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const res: any = await fetchWithRetry(
    f,
    url,
    { compress: false, headers: { "accept-encoding": "gzip" } },
    label,
  );
  const header = (name: string): string =>
    res.headers?.get?.(name.toLowerCase()) ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    contentEncoding: header("content-encoding"),
    header,
    expectedBytes: expectedByteLength({
      contentLength: header("content-length"),
      storedContentLength: header("x-goog-stored-content-length"),
    }),
  };
}

/** Raw bytes → text. Whether to gunzip is decided by content-encoding. */
export function decodeRawPayload(raw: RawDownload): string {
  if (raw.contentEncoding === "gzip") {
    return gunzipSync(raw.bytes).toString("utf8");
  }
  return raw.bytes.toString("utf8");
}
