import { useEffect, useState } from "react";

/**
 * since(绝对 ms 时间戳)→ 已耗秒数,每秒滚动;since 为 null 时返回 null 并
 * 停表。给「分析中/对比中」状态行用:起点来自 main 的
 * runningMeta.since / startedAt,所以重挂载(去开发者页再回来)后计时仍然
 * 是真实已耗时,不会归零谎报。
 */
export function useElapsedSince(since: number | null): number | null {
  const [elapsedS, setElapsedS] = useState<number | null>(
    since == null ? null : (Date.now() - since) / 1000,
  );
  useEffect(() => {
    if (since == null) {
      setElapsedS(null);
      return;
    }
    setElapsedS((Date.now() - since) / 1000);
    const timer = setInterval(
      () => setElapsedS((Date.now() - since) / 1000),
      1000,
    );
    return () => clearInterval(timer);
  }, [since]);
  return since == null ? null : elapsedS;
}
