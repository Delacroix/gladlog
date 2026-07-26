import { ensureSpellNames } from "./spellEffectData";
import { ensureTalentData, talentDataReady } from "./talentStrings";
import { ensureHeroTalents } from "../utils/talents";

/** 大数据表(spellNames 12MB / talentIdMap 1.6MB)是后台加载的:模块求值
 * 即踢加载但不阻塞模块图(TLA 曾让 renderer 首屏串行等 12MB)。
 *
 * 契约:**任何构建提示词的入口必须先 await 本函数** —— 法术名/天赋名进
 * prompt 不许降级(门规会复算渲染文本)。UI 展示路径可以不等(logName/
 * 空数组兜底,加载完成后的下一次渲染自愈)。
 * 现有三个入口:renderer StructuredAnalysisPanel(dataReady 门)、
 * main deepenInner、eval buildCorpus。新增入口照抄。 */
export async function ensureAnalysisData(): Promise<void> {
  await Promise.all([
    ensureSpellNames(),
    ensureTalentData(),
    ensureHeroTalents(),
  ]);
}

/** 同步就绪探针(UI 用:已就绪则跳过一次 setState 往返)。
 * 只测 talent 门是不够的 —— 三份数据一起 ensure,这里保守起见仍以
 * talentDataReady 为代表:三个 import 同批踢出,实际完成时刻几乎一致,
 * 且探针只用于「省一次重渲」,错判 false 无害。 */
export const analysisDataReady = (): boolean => talentDataReady();
