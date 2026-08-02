/**
 * Whether this run executes **only** the e2e project.
 *
 * playwright.config uses it to decide whether to start the dev:ui test-bed
 * server: e2e drives the packaged Electron app, so starting the server just
 * means waiting through a build for nothing — and on a local machine it also
 * collides on the port.
 *
 * It lives in its own file so unit tests can cover it — this used to be written
 * inline in the config as `process.argv.includes("--project=e2e")`, which only
 * recognizes the equals form; writing `--project e2e` (the space form, equally
 * accepted by Playwright) made it silently stop working. A condition of the
 * kind "when written wrong it does not fail, it just wastes a run" must be
 * pinned down by a test.
 */
export function isE2EOnlyRun(argv: readonly string[]): boolean {
  const projects: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) projects.push(next);
    } else if (arg.startsWith("--project=")) {
      projects.push(arg.slice("--project=".length));
    }
  }
  // Naming no project = run everything, so the server is needed; if projects
  // ARE named, every one of them must be e2e before we skip it.
  return projects.length > 0 && projects.every((p) => p === "e2e");
}
