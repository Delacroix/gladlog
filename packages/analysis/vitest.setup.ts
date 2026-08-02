// Since the big data tables (spellNames/talentIdMap) moved to background loading
// (see src/data/ensure.ts), an import no longer guarantees they are ready —
// name and talent assertions would go red at random depending on load timing.
// Wait for them once, here.
import { ensureAnalysisData } from "./src/data/ensure";

await ensureAnalysisData();
