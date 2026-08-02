// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { specIconName } from "../data/gameConstants";
import { SpecInline, SpellInline } from "./SpellInline";

describe("SpellInline", () => {
  test("title=英文原名,正文=display,有图标条目渲染图标占位", () => {
    // 740 Tranquility is in SPELL_ICONS_GENERATED (used by the lanes)
    const { container } = render(
      <SpellInline spellId="740" display="宁静" original="Tranquility" />,
    );
    const el = container.querySelector(".rpt-inline-spell")!;
    expect(el.getAttribute("title")).toBe("Tranquility");
    expect(el.textContent).toContain("宁静");
    // No bridge stub → SpellIcon renders the fallback placeholder (empty label
    // → empty string); asserting the placeholder node exists is enough (the
    // real image goes through IPC, which the test environment doesn't fetch).
    expect(container.querySelector(".rpt-spellicon-fallback")).not.toBeNull();
  });

  test("无图标条目:只出文本,不渲染图标节点", () => {
    // 999999999 is confirmed absent from SPELL_ICONS_GENERATED (spellId "1"
    // turned out to be taken by the data table, mapping to trade_engineering,
    // so it can no longer serve as a "no table entry" sample).
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
    // Spec icons moved from direct external CDN links to iconCache
    // (docs/DATA-COMPLIANCE.md), taking the same path as spell icons: with no
    // bridge stub in the test environment it renders the fallback placeholder
    // rather than an img.
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
    // The official icon for Restoration Druid (105); the old implementation
    // returned external-CDN slugs like "druid_restoration" — this test guards
    // against regressing to that.
    expect(specIconName(105)).toBe("spell_nature_healingtouch");
    expect(specIconName(264)).toBe("spell_nature_magicimmunity");
    expect(specIconName(999999)).toBeNull();
  });
});
