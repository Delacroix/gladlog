// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { SpecInline, SpellInline } from "./SpellInline";

describe("SpellInline", () => {
  test("title=英文原名,正文=display,有图标条目渲染图标占位", () => {
    // 740 Tranquility 在 SPELL_ICONS_GENERATED(泳道在用)
    const { container } = render(
      <SpellInline spellId="740" display="宁静" original="Tranquility" />,
    );
    const el = container.querySelector(".rpt-inline-spell")!;
    expect(el.getAttribute("title")).toBe("Tranquility");
    expect(el.textContent).toContain("宁静");
    // bridge 桩缺席 → SpellIcon 走 fallback 占位(空 label → 空字符),
    // 断言占位节点存在即可(真图走 IPC,测试环境不取)。
    expect(container.querySelector(".rpt-spellicon-fallback")).not.toBeNull();
  });

  test("无图标条目:只出文本,不渲染图标节点", () => {
    // 999999999 确认不在 SPELL_ICONS_GENERATED 里(spellId "1" 实测已被
    // 数据表占用,映射到 trade_engineering,不可再用作"无表项"样本)。
    const { container } = render(
      <SpellInline
        spellId="999999999"
        display="召回"
        original="Word of Recall (OLD)"
      />,
    );
    expect(container.querySelector(".rpt-spellicon-fallback")).toBeNull();
    expect(container.textContent).toBe("召回");
  });

  test("SpecInline 渲染专精图标 img + display", () => {
    const { container } = render(
      <SpecInline
        specId={105}
        display="恢复德鲁伊"
        original="Restoration Druid"
      />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("druid_restoration");
    expect(container.textContent).toContain("恢复德鲁伊");
  });
});
