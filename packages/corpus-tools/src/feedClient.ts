import { gunzipSync } from "node:zlib";

export interface MatchStub {
  id: string;
  bracket: string;
  rating: number;
  logObjectUrl: string;
}

const FEED_ENDPOINT = "https://wowarenalogs.com/api/graphql";
// 真实 query(取自旧 fork CLEAN 的 fetchStubs;go/no-go 冒烟实证)。minRating 为**服务端**变量,
// 返回的 combats 已按评分过滤,客户端无需再按 rating 过滤。`combats` 是接口类型 CombatDataStub,
// 字段必须经 `... on ArenaMatchDataStub` / `... on ShuffleRoundStub` 内联片段选择(直接选字段会 400)。
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
 * 出站身份标识。wowarenalogs 是**第三方志愿者项目**,feed 与 GCS 的账单是他们的;
 * 裸 node-fetch 默认头会让我们在对方日志里跟任意爬虫无法区分——真要处置只能整段
 * 封 IP,连带误伤别人。带上工具名与仓库地址,对方随时能查到我们是谁、在干什么,
 * 需要我们降频或停手时也有联系方式。合规依据见 docs/DATA-COMPLIANCE.md。
 */
export const USER_AGENT =
  "gladlog-corpus-tools/1.0 (+https://github.com/mingjianliu/gladlog)";

/**
 * 把 UA 并进 init.headers,保留调用方已有的头。init 可能是 undefined
 * (GCS 裸 GET),此时也要造出带 UA 的 init——单源在此,调用方无需各自记得。
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
  // 唯一出站咽喉:feed 查询与 GCS log 下载都经此,UA 在这里挂一次就全覆盖。
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
            minRating: opts.minRating, // 服务端过滤
          },
        }),
      },
      "feed",
    );
    const combats = (await res.json())?.data?.latestMatches?.combats ?? [];
    if (combats.length === 0) break;
    for (const c of combats) {
      // 服务端已按 minRating 过滤;客户端只做映射。
      out.push({
        id: c.id,
        bracket: opts.bracket,
        rating: opts.minRating,
        logObjectUrl: c.logObjectUrl,
      });
      if (out.length >= opts.limit) break;
    }
    // 短页(少于请求的 count)代表已到 feed 末尾,避免对 mock/真实分页无限重复请求同一页。
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

// ── 详细 stubs(fetch-public 语料抓取用)────────────────────────────────────
// 与 STUBS_QUERY 同一端点/同一分页/同一重试;字段超集:识别记录者与高级日志。
// 注意:minRating 是服务端 Firestore 复合索引变量,必须与 bracket 同传
// (bracket:null + minRating → FAILED_PRECONDITION,2026-07-16 实测)。

export interface DetailedStubUnit {
  id: string;
  name: string;
  spec: string;
  reaction: number;
  // COMBATANT_INFO 派生的玩家详情;非玩家单位(宠物/图腾)为 null。
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
  // 评分/时间元数据(2026-07-29 introspection 实证字段)。startTime 为上传方 epoch ms。
  startTime: number;
  result: number;
  playerTeamRating: number;
  winningTeamId: string;
  playerTeamId: string;
  team0MMR: number;
  team1MMR: number;
}

// compQueryString:服务端预索引的队伍 spec 组合过滤(specId 字符串**字典序**排序后 `_`
// 连接,如 "105_263";子集也被索引,双边用 "AxB")。minRating 只有 1400/1800/2100/2400
// 四档生效,判据是场均 MMR —— 均为 2026-07-29 对 wowarenalogs 源码 + 真实请求实证。
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
    // ShuffleRoundStub 无 endInfo(整场 MMR 在 shuffleMatchEndInfo),缺省 0。
    team0MMR: c.endInfo?.team0MMR ?? 0,
    team1MMR: c.endInfo?.team1MMR ?? 0,
  }));
  return { stubs, queryLimitReached: !!data.queryLimitReached };
}

/**
 * GCS 返回头里可用来核验完整性的字节数:优先 x-goog-stored-content-length
 * (GCS 存储对象的原始大小,不受 transfer-encoding 影响),兜底 content-length。
 * 都拿不到(某些代理/测试 fetch 不回传)时返回 undefined——上层不做字节判据,
 * 不能把"没有 header"误判成"截断"。
 *
 * 本从 pvpLogFetch.ts 搬到这里:downloadRaw 需要它,而 feedClient 不能反向
 * import pvpLogFetch 的值(pvpLogFetch 已从 feedClient import 类型,反向再引
 * 值就成运行时循环)。pvpLogFetch.ts 原位置改为一行 re-export。
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
  /** 未解压的响应体字节。GCS 上对象是 gzip 存储,这里就是那份压缩字节。 */
  bytes: Buffer;
  /** 响应的 content-encoding,通常是 "gzip";空串表示未压缩。 */
  contentEncoding: string;
  /** 取响应头(小写名),缺失返回空串。 */
  header(name: string): string;
  /** GCS 声明的字节数(= 压缩尺寸),拿不到则 undefined。 */
  expectedBytes: number | undefined;
}

/**
 * 下载但**不解压**。
 *
 * node-fetch 默认 compress:true 会自动 gunzip,于是 content-length(压缩尺寸)
 * 与拿到的正文长度对不上,既没法校验截断,也逼着我们把对方压缩好的数据解压后
 * 再存(实测膨胀 11.4x)。compress:false 让 node-fetch 不在客户端自动解压。
 *
 * 但只有 compress:false 不够——2026-08-01 真机验证抓到:node-fetch 只在
 * compress:true 时才会自动带上 `Accept-Encoding: gzip`(见 node-fetch v3
 * request.js `if (request.compress && !headers.has('Accept-Encoding'))`)。
 * compress:false 时请求不带该 header,GCS 对 gzip 存储对象的默认行为是
 * **服务端转码**:没收到 `Accept-Encoding: gzip` 就直接把对象解压后再发,
 * 同时响应**不带** content-length/content-encoding(chunked),但
 * `x-goog-stored-content-length`(压缩尺寸)照常返回——于是"expected 压缩
 * 尺寸、got 解压后字节数"的字节不匹配在这一层原样重演了一次,与 c9c463e
 * 是同一形状的 bug,只是从"文本层错误比较"搬到了"没显式要压缩响应"。
 * 因此必须显式声明 `Accept-Encoding: gzip`,让 GCS 老实吐压缩字节,
 * 再靠 compress:false 让 node-fetch 别在客户端替我们解开。
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

/** 原始字节 → 文本。按 content-encoding 决定是否 gunzip。 */
export function decodeRawPayload(raw: RawDownload): string {
  if (raw.contentEncoding === "gzip") {
    return gunzipSync(raw.bytes).toString("utf8");
  }
  return raw.bytes.toString("utf8");
}
