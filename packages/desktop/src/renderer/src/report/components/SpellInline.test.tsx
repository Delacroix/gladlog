// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { specIconName } from "../data/gameConstants";
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

  test("SpecInline 走 SpellIcon 取图 + display", () => {
    // 专精图标已从外部 CDN 直链改为 iconCache(docs/DATA-COMPLIANCE.md),
    // 与技能图标同一条路:测试环境无 bridge 桩 → 渲染 fallback 占位而非 img。
    const { container } = render(
      <SpecInline
        specId={105}
        display="恢复德鲁伊"
        original="Restoration Druid"
      />,
    );
    expect(container.querySelector(".rpt-spellicon-fallback")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("恢复德鲁伊");
  });

  test("未知 spec:不渲染图标节点,只出文本", () => {
    const { container } = render(
      <SpecInline specId={999999} display="未知" original="Unknown" />,
    );
    expect(container.querySelector(".rpt-spellicon-fallback")).toBeNull();
    expect(container.textContent).toBe("未知");
  });
});

describe("specIconName", () => {
  test("解析到暴雪 DB2 的图标基名,而不是外部 CDN slug", () => {
    // 恢复德鲁伊(105)的官方图标;旧实现给的是 "druid_restoration" 这种
    // 外部 CDN slug —— 这条守的就是别退回去。
    expect(specIconName(105)).toBe("spell_nature_healingtouch");
    expect(specIconName(264)).toBe("spell_nature_magicimmunity");
    expect(specIconName(999999)).toBeNull();
  });
});
