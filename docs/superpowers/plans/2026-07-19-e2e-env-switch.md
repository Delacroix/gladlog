# GLADLOG_E2E userData redirection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `GLADLOG_E2E` userData redirection switch in the desktop process to redirect userData to a temporary absolute directory during E2E runs, avoiding mutation of production user data.

**Architecture:** Create an `e2eEnv.ts` helper and its test suite, then integrate it into the main app lifecycle (within `packages/desktop/src/main/index.ts`) before settings/userData initialization.

**Tech Stack:** TypeScript, Node.js, Electron, Jest (for workspace testing).

---

### Task 1: Create failing test for e2eEnv

**Files:**
- Create: `packages/desktop/src/main/e2eEnv.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { e2eUserDataDir } from "./e2eEnv";

describe("e2eUserDataDir", () => {
  it("Not enabled → null", () => {
    expect(e2eUserDataDir({})).toBeNull();
    expect(e2eUserDataDir({ GLADLOG_E2E_USER_DATA: "/tmp/x" })).toBeNull();
  });

  it("Enabled and absolute path provided → returns the path", () => {
    expect(
      e2eUserDataDir({
        GLADLOG_E2E: "1",
        GLADLOG_E2E_USER_DATA: "/tmp/gl-e2e",
      }),
    ).toBe("/tmp/gl-e2e");
  });

  it("Enabled but path is missing or non-absolute → throw error (never fallback to real userData)", () => {
    expect(() => e2eUserDataDir({ GLADLOG_E2E: "1" })).toThrow();
    expect(() =>
      e2eUserDataDir({ GLADLOG_E2E: "1", GLADLOG_E2E_USER_DATA: "rel/path" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/desktop -- e2eEnv`
Expected: FAIL due to missing module `./e2eEnv`.

---

### Task 2: Implement e2eEnv logic and verify tests pass

**Files:**
- Create: `packages/desktop/src/main/e2eEnv.ts`

- [ ] **Step 1: Write minimal implementation**

```typescript
import { isAbsolute } from "path";

/**
 * userData directory under E2E mode. The switch only does one thing: moves the state directory to a temporary path,
 * allowing end-to-end tests to run on a clean, disposable state.
 *
 * When enabled but no valid path is provided, **throw an error instead of falling back** -- silently using real userData would let
 * the tests pollute user data.
 */
export function e2eUserDataDir(env: NodeJS.ProcessEnv): string | null {
  if (env["GLADLOG_E2E"] !== "1") return null;
  const dir = env["GLADLOG_E2E_USER_DATA"];
  if (!dir || !isAbsolute(dir)) {
    throw new Error(
      "GLADLOG_E2E=1 requires GLADLOG_E2E_USER_DATA to point to an absolute path",
    );
  }
  return dir;
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test --workspace=packages/desktop -- e2eEnv`
Expected: PASS (3 passed)

---

### Task 3: Integrate e2eEnv into desktop process entry point

**Files:**
- Modify: `packages/desktop/src/main/index.ts`

- [ ] **Step 1: Modify packages/desktop/src/main/index.ts to import and apply getPath redirection**

Import:
```typescript
import { e2eUserDataDir } from "./e2eEnv";
```

Logic insertion (directly after `app.setName("gladlog");` around line 22):
```typescript
// E2E: Must be earlier than any app.getPath("userData") call (like the settings below)
const e2eDir = e2eUserDataDir(process.env);
if (e2eDir) app.setPath("userData", e2eDir);
```

- [ ] **Step 2: Verify execution order and build correctness**

Run checks:
```bash
npm test --workspace=packages/desktop && npm run typecheck
node -e "
const s=require('fs').readFileSync('packages/desktop/src/main/index.ts','utf8');
const setPath=s.indexOf('app.setPath(\"userData\"');
const getPath=s.indexOf('app.getPath(\"userData\")');
if(setPath<0||getPath<0) throw new Error('Expected calls not found');
if(setPath>getPath) throw new Error('setPath must be earlier than the first getPath');
console.log('userData redirection order is correct');
"
```
Expected: `userData redirection order is correct` and no TS errors.

---

### Task 4: Lint, typecheck, verify all, and commit

- [ ] **Step 1: Run comprehensive tests and linting**

Run:
```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet
```

- [ ] **Step 2: Commit changes**

```bash
git add packages/desktop/src/main/e2eEnv.ts packages/desktop/src/main/e2eEnv.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(main): GLADLOG_E2E userData redirection -- E2E runs on temporary state"
```
