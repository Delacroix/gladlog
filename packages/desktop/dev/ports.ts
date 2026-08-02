/** Port of the dev:ui test bed.
 *
 *  Single-source predicate: the port vite actually serves on (both dev server
 *  and preview) and Playwright's webServer.url and baseURL all read it from
 *  here. Hard-code the literal anywhere and changing the port will miss it. */
export const VISUAL_PORT = 5199;
