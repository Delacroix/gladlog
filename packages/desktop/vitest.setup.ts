// Since the large data tables (spellNames/talentIdMap) moved to background
// loading (analysis' data/ensure.ts), an import no longer guarantees they are
// ready — name/talent assertions would go red at random depending on load
// timing. Wait for them once, here, for everyone.
import { ensureAnalysisData } from "@gladlog/analysis";

await ensureAnalysisData();
