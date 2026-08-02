/**
 * External-network isolation for visual regression.
 *
 * Why it is needed: the baseline is a pixel-level single-source standard, yet
 * the page used to fetch resources from the public internet at runtime (the
 * arena minimap background — the wowarenalogs CDN in arenaMaps.ts). If the
 * fetch succeeded it was drawn, if not it was not, so **the same code** could
 * produce two different images across two CI runs. Run 29771469113 on
 * 2026-07-20 went red exactly this way: report-replay differed by 2286 px, and
 * the next push turned green on its own without touching any UI code.
 *
 * Since 2026-08-01 the root cause is removed rather than merely masked: the
 * minimap backgrounds ship inside the bundle (import.meta.glob in
 * arenaMaps.ts), and spell/spec icons go through the main process's iconCache,
 * which is offline under GLADLOG_E2E=1 (page.route cannot intercept the main
 * process, so that one can only be switched off on the main-process side).
 * The page therefore **must not request any external host at all**, so nothing
 * is allowlisted here: everything is recorded and aborted, and the test
 * asserts the ledger is empty. Adding a new CDN dependency fails the test
 * outright and names the offender instead of leaving a flaky red behind.
 */
import type { Page } from "@playwright/test";

/**
 * Block every non-localhost request on the page. Returns the **leak ledger**:
 * the external URLs that were blocked. Tests must assert it is empty — a
 * non-empty ledger means a new dependency was added that would let the
 * baseline drift with the network.
 */
export async function isolateExternalRequests(page: Page): Promise<string[]> {
  const leaked: string[] = [];
  // The await is mandatory: registering the route is itself asynchronous, and
  // calling goto before it lands misses the first batch of requests — which
  // would reintroduce the very "occasionally fails to block" behaviour.
  await page.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    (route) => {
      leaked.push(route.request().url());
      return route.abort();
    },
  );
  return leaked;
}
