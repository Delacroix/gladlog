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
