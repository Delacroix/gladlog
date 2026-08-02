/** Accessibility exemption list: the standard is WCAG 2.1 A+AA, and the set of
 *  violations must be ⊆ this list.
 *  Policy = fix it or exempt it explicitly; silence is not allowed. This file
 *  IS the visible tech-debt list. */
export type AxeExemption = {
  /** The axe rule id, e.g. "color-contrast" */
  rule: string;
  /** Selector of the violating node (axe's reported target[0]); prefix
   *  matching is supported */
  selector: string;
  /** Why this is accepted — one line, no hand-waving */
  why: string;
};

export const AXE_EXEMPTIONS: AxeExemption[] = [
  {
    rule: "color-contrast",
    selector: "",
    why: "首扫 82 处,全部是深色游戏风 UI 里刻意压暗的次级信息(时间戳、单位、占位说明、未选中的 tab、泳道刻度)——按信息层级分档压暗是这套界面的基本手法,逐处抬亮等于重做配色。整体调档是独立的设计工作,不在质检体系这一期。空 selector = 该规则全量豁免;这是清单里唯一的全量豁免,收窄它就是那次配色工作的验收标准。",
  },
];

export function isExempt(rule: string, target: string): boolean {
  return AXE_EXEMPTIONS.some(
    (e) => e.rule === rule && target.startsWith(e.selector),
  );
}
