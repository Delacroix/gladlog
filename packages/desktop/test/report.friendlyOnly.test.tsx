// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Timeline } from "../src/renderer/src/report/components/Timeline";
import type { TeamSide } from "../src/renderer/src/report/derive/teamSide";

/**
 * 「只看我方」(T7)的行为契约。
 *
 * 这个开关是「不改默认态」方案的落点:工单原本要把 hidden 的初始值预填成
 * 敌方,那会同时打死首点 solo、跨轮次错认敌我、并把伤害榜敌方默认置灰。
 * 所以这里要钉死的三件事是:
 *   1. 点一下,本场 roster 的非我方单位全部进 hidden(我方一个不动);
 *   2. 再点一下,只清掉本场 roster 的条目 —— hidden 里别场对局的 id 是刻意
 *      保留的用户偏好,不许被这个按钮顺手清掉;
 *   3. 写的是调用方传进来的同一份 state,伤害榜拿到的是同一个集合。
 */

const SIDES = new Map<string, TeamSide>([
  ["u1", "friendly"],
  ["u2", "friendly"],
  ["u3", "enemy"],
  ["u4", "enemy"],
]);

const series = [
  { unitId: "u1", name: "Ally1-Test", classId: 5, points: [] },
  { unitId: "u2", name: "Ally2-Test", classId: 2, points: [] },
  { unitId: "u3", name: "Foe1-Test", classId: 9, points: [] },
  { unitId: "u4", name: "Foe2-Test", classId: 1, points: [] },
];

const data = {
  start: 0,
  end: 60_000,
  series,
  deaths: [],
} as unknown as Parameters<typeof Timeline>[0]["data"];

/** 调用方持有 hidden —— 与 MatchReport 的接线一致(同一份 state 同时喂给
 *  Timeline 和伤害榜)。`seed` 用来模拟「hidden 里还留着别场对局的 id」。 */
function Harness({ seed = [] as string[] }: { seed?: string[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set(seed));
  return (
    <>
      <Timeline
        data={data}
        hidden={hidden}
        teamSides={SIDES}
        onSelectUnit={(id) =>
          setHidden((p) => {
            const n = new Set(p);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          })
        }
        onSetHidden={setHidden}
      />
      {/* 伤害榜的替身:证明它拿到的就是同一个集合 */}
      <div data-testid="meters-hidden">
        {[...hidden].sort().join(",") || "(none)"}
      </div>
    </>
  );
}

const hiddenNow = () => screen.getByTestId("meters-hidden").textContent;

describe("Timeline 只看我方开关(T7)", () => {
  it("点一下只隐藏本场非我方单位,我方不动", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("只看我方"));
    expect(hiddenNow()).toBe("u3,u4");
  });

  it("再点一下恢复全部,且不动别场对局留下的 id", () => {
    render(<Harness seed={["other-match-unit"]} />);
    fireEvent.click(screen.getByText("只看我方"));
    expect(hiddenNow()).toBe("other-match-unit,u3,u4");

    // 此时按钮应已切换成「全部」并标记为按下态
    const back = screen.getByText("全部");
    expect(back.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(back);
    // 别场的 id 必须活下来
    expect(hiddenNow()).toBe("other-match-unit");
  });

  it("敌方已被逐条点掉时,按钮自己就是按下态(按 roster 判定而非按集合非空)", () => {
    render(<Harness seed={["u3", "u4"]} />);
    expect(screen.getByText("全部").getAttribute("aria-pressed")).toBe("true");
  });

  it("没有 onSetHidden 就不渲染这个按钮(旧调用方不受影响)", () => {
    render(<Timeline data={data} hidden={new Set()} teamSides={SIDES} />);
    expect(screen.queryByText("只看我方")).toBeNull();
    expect(screen.queryByText("全部")).toBeNull();
  });
});
