// 大数据表(spellNames/talentIdMap)改后台加载后(见 src/data/ensure.ts),
// import 不再保证表就绪 —— 名字/天赋类断言会随加载时序随机红。统一等到位。
import { ensureAnalysisData } from "./src/data/ensure";

await ensureAnalysisData();
