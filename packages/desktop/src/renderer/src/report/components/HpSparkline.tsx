import type { DeathRecapEvent } from "../derive/deathRecap";

export function HpSparkline({
  hpSeries,
  events,
  fromS,
  toS,
}: {
  hpSeries: Array<{ tS: number; pct: number }>;
  events: DeathRecapEvent[];
  fromS: number;
  toS: number;
}) {
  // viewBox 与 CSS 尺寸同为 260×100:等比映射,文字/线宽不畸变。
  const xDomain = toS - fromS;
  const getX = (tS: number) => {
    if (xDomain <= 0) return 0;
    return ((tS - fromS) / xDomain) * 260;
  };
  const getY = (pct: number) => {
    return 100 - pct;
  };

  const segments = [];
  for (let i = 1; i < hpSeries.length; i++) {
    const p1 = hpSeries[i - 1]!;
    const p2 = hpSeries[i]!;
    let segClass = "rpt-hpspark-seg-flat";
    if (p2.pct < p1.pct) {
      segClass = "rpt-hpspark-seg-down";
    } else if (p2.pct > p1.pct) {
      segClass = "rpt-hpspark-seg-up";
    }
    segments.push(
      <line
        key={`seg-${i}`}
        x1={getX(p1.tS)}
        y1={getY(p1.pct)}
        x2={getX(p2.tS)}
        y2={getY(p2.pct)}
        className={segClass}
      />,
    );
  }

  const ticks = events
    .filter(
      (e) =>
        (e.kind === "cc" || e.kind === "def_used") &&
        e.tS >= fromS &&
        e.tS <= toS,
    )
    .map((e, i) => {
      const x = getX(e.tS);
      return (
        <line
          key={`tick-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={100}
          className={`rpt-hpspark-tick k-${e.kind}`}
        >
          <title>{e.spell}</title>
        </line>
      );
    });

  return (
    <svg
      viewBox="0 0 260 100"
      className="rpt-hpspark"
      role="img"
      aria-label="血量曲线"
    >
      {segments}
      {ticks}
      <text x={getX(toS)} y={96} textAnchor="end">
        ☠
      </text>
    </svg>
  );
}
