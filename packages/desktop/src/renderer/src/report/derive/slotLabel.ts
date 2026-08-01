import { AI_MODELS, type AiBackend } from "../../../../shared/aiModels";
// 必须从 analysisSlots(零 fs/path 依赖)import,不能从 analysisCache import
// ——后者顶部有 `import { join } from "path"`,renderer 引入会把 Node 内置
// 模块拖进浏览器 bundle,electron-vite build 才会炸(见 analysisCache.ts
// 头部注释;presubmit 抓到过一次)。
import { splitSlotKey } from "../../../../shared/analysisSlots";

/**
 * 槽键 → 后端显示名。独立小模块(而非塞进 StructuredAnalysisPanel.tsx)是
 * 因为 Task 4 的槽选择菜单要复用 `slotLabel`,而那个菜单很可能被
 * StructuredAnalysisPanel 引入渲染——纯函数放进 UI 组件文件会埋下循环依赖
 * 隐患(agy flash 复核 F3),derive/ 是零 React 依赖的展示层,谁引用都安全。
 */
const BACKEND_LABELS: Record<AiBackend, string> = {
  anthropic: "Claude API",
  claudeCli: "Claude CLI",
  agy: "agy",
  codex: "Codex",
  deepseek: "DeepSeek",
};

/**
 * 槽键(`${backend}:${model}`,见 shared/analysisSlots.ts 的 slotKeyOf)→
 * tab/菜单显示文案。拆分谓词单源(`splitSlotKey`,与 main/analysis.ts
 * deepenInner 共用,见该函数注释)——不再各自手写 `indexOf(":")`。后端查
 * BACKEND_LABELS,模型查 AI_MODELS,两者都是未知值原样透传(手改配置/
 * 未来新模型不炸)。
 */
export function slotLabel(key: string): string {
  const split = splitSlotKey(key);
  if (!split) return key;
  const { backend, model } = split;
  const backendLabel = BACKEND_LABELS[backend as AiBackend] ?? backend;
  const modelLabel =
    AI_MODELS[backend as AiBackend]?.find((m) => m.id === model)?.label ??
    model;
  return `${backendLabel} · ${modelLabel}`;
}
