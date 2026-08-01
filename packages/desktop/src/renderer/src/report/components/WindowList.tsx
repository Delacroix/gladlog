import type { VulnBand } from "../derive/vulnWindows";

const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 窗口列表(1c):生命曲线下方,每个击杀/脆弱窗口一行,整行可点跳回放。
 * 色条:金 = 击杀尝试,红 = 脆弱未惩罚(与曲线色带同谓词 deriveVulnBands)。
 */
export function WindowList({
  bands,
  onSeek,
}: {
  bands: VulnBand[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  if (bands.length === 0) return null;
  return (
    // 1a 压缩后是滚动区(max-height+overflow):必须可键盘聚焦,否则
    // axe scrollable-region-focusable 报红(键盘用户滚不动它)。
    <div
      className="rpt-windows"
      data-testid="window-list"
      tabIndex={0}
      role="region"
      aria-label="击杀/脆弱窗口列表"
    >
      {bands.map((b, i) => (
        <div
          key={i}
          className={onSeek ? "rpt-window rpt-window-click" : "rpt-window"}
          onClick={onSeek ? () => onSeek(b.fromS, [b.targetName]) : undefined}
        >
          <span
            className="rpt-window-bar"
            style={{
              background: b.kind === "burst" ? "var(--gold)" : "var(--loss)",
            }}
          />
          <span className="rpt-window-t">
            {mmss(b.fromS)}–{mmss(b.toS)}
          </span>
          <span className="rpt-window-title">
            {b.kind === "burst"
              ? `击杀尝试 → ${b.targetName.split("-")[0]}`
              : `${b.targetName.split("-")[0]} 脆弱且未被惩罚`}
          </span>
          <span className="rpt-window-detail">
            团队伤害{b.kind === "burst" ? "" : "仅"}{" "}
            {(b.damage / 1000).toFixed(0)}k
          </span>
          {/* 行尾时长 + 击杀结果 chip(P3-2) */}
          <span className="rpt-ledger-chip rpt-ledger-chip-dim">
            {Math.round(b.toS - b.fromS)}s
          </span>
          {b.targetDied && (
            <span className="rpt-ledger-chip rpt-ledger-chip-kill">击杀</span>
          )}
          {onSeek && <span className="rpt-window-go">▶ 回放</span>}
        </div>
      ))}
    </div>
  );
}
