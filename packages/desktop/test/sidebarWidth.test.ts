import { describe, expect, it } from "vitest";

import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "../src/renderer/src/sidebarWidth";

/**
 * 侧栏宽度的夹取判据。
 *
 * 脏值必须回落到默认值而不是原样透传:这个数最终会进 grid-template-columns,
 * 一个 NaN 会让列轨静默塌成 0 —— 对局列表整个消失,而用户没有任何入口把它
 * 拖回来(拖拽条本身也在那条塌掉的轨旁边)。
 */
describe("clampSidebarWidth", () => {
  it("区间内原样返回", () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(SIDEBAR_MIN)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(SIDEBAR_MAX)).toBe(SIDEBAR_MAX);
  });

  it("越界夹回边界(拖过头不该把列表拖没)", () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(99999)).toBe(SIDEBAR_MAX);
  });

  it("脏值一律回默认值,绝不吐出 NaN", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      "",
      "abc",
      {},
    ]) {
      expect(clampSidebarWidth(bad)).toBe(SIDEBAR_DEFAULT);
    }
  });

  it("localStorage 存的是字符串,要能解析", () => {
    // readPersisted 直接把 getItem 的结果喂进来,所以字符串路径必须走通,
    // 否则每次启动都悄悄回落到默认值,用户的拖拽结果看似没保存。
    expect(clampSidebarWidth("340")).toBe(340);
    expect(clampSidebarWidth("340.5")).toBe(340.5);
  });
});
