// Since the large data tables (spellNames/talentIdMap) moved to background
// loading (analysis' data/ensure.ts), an import no longer guarantees they are
// ready — name/talent assertions would go red at random depending on load
// timing. Wait for them once, here, for everyone.
import { configure } from "@testing-library/react";

import { ensureAnalysisData } from "@gladlog/analysis";

// GH #26 flaky ledger: every recorded flake (devpanel.detail "expanding one
// container…", StructuredAnalysisPanel "slotKey mismatches…") is a
// testing-library `waitFor`/`findBy*` expiring at its default 1000ms on a
// saturated CI runner — "expected null to be truthy" is that timeout's shape;
// same SHA green on rerun / isolated (four records, 2026-08-19..22). Not
// reproducible locally without manufacturing machine-wide load (which is
// forbidden on this machine — see the 2026-08-18/27 incidents). No assertion
// in this suite depends on something *not* happening within 1s, so a longer
// wait only changes when a genuinely broken test fails. vitest's per-test
// ceiling is raised alongside (vitest.config.ts testTimeout) so a test with
// several slow awaits fails on its own assertion, not on the harness clock.
configure({ asyncUtilTimeout: 5000 });

await ensureAnalysisData();
