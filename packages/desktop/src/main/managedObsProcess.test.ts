import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnManagedObs } from "./managedObsProcess";

/** Stands in for node:child_process's ChildProcess: an EventEmitter with the
 * handful of members managedObsProcess actually touches (pid, kill, on/once
 * are all EventEmitter already provides — kill is overridden to be a spy). */
class FakeChildProcess extends EventEmitter {
  pid = 4242;
  kill = vi.fn(() => true);
}

let dir: string;
let obsRoot: string;
let logsDir: string;
let fakeChild: FakeChildProcess;
let spawnCalls: Array<{ exe: string; args: string[]; opts: unknown }>;
let spawnImpl: typeof nodeSpawn;
let killTreeImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "gladlog-managed-obs-"));
  obsRoot = join(dir, "obs", "32.2.1");
  logsDir = join(obsRoot, "config", "obs-studio", "logs");
  mkdirSync(logsDir, { recursive: true });
  fakeChild = new FakeChildProcess();
  spawnCalls = [];
  spawnImpl = ((exe: string, args: string[], opts: unknown) => {
    spawnCalls.push({ exe, args, opts });
    return fakeChild;
  }) as unknown as typeof nodeSpawn;
  killTreeImpl = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, content: string): void {
  writeFileSync(join(logsDir, name), content);
}

function appendLog(name: string, content: string): void {
  writeFileSync(join(logsDir, name), content, { flag: "a" });
}

describe("spawnManagedObs — spawn shape", () => {
  it("spawns the exe with cwd=<obsRoot>/bin/64bit and the exact product flag set (no extraArgs)", () => {
    spawnManagedObs({ obsRoot, wsPort: 4466, spawnImpl, killTreeImpl });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.exe).toBe(join(obsRoot, "bin", "64bit", "obs64.exe"));
    expect(call.args).toEqual([
      "--portable",
      "--multi",
      "--only-bundled-plugins",
      "--minimize-to-tray",
      "--disable-updater",
      "--disable-missing-files-check",
      "--collection",
      "gladlog",
      "--profile",
      "gladlog",
      "--scene",
      "gladlog",
      "--websocket_ipv4_only",
    ]);
    expect(call.opts).toMatchObject({
      cwd: join(obsRoot, "bin", "64bit"),
      stdio: "ignore",
    });
  });

  it("appends extraArgs after the product flags (gate-script-only escape hatch)", () => {
    spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
      extraArgs: ["--websocket_port", "4466", "--websocket_password", "pw"],
    });
    const call = spawnCalls[0]!;
    expect(call.args.slice(-4)).toEqual([
      "--websocket_port",
      "4466",
      "--websocket_password",
      "pw",
    ]);
  });
});

describe("spawnManagedObs — readiness (log-based, never TCP)", () => {
  it("resolves ready with wsUrl once a NEW log has both Portable mode: true and a websocket-started line", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    writeLog(
      "2026-08-04 12-21-00.txt",
      "Portable mode: true\n" +
        "[obs-websocket] Server started successfully on port 4466\n",
    );
    await vi.advanceTimersByTimeAsync(600);
    await expect(handle.ready).resolves.toEqual({
      wsUrl: "ws://127.0.0.1:4466",
    });
  });

  it("does NOT resolve when only an OLD (pre-spawn) log contains both keywords — must time out with 'OBS 未产出日志'", async () => {
    // Old log exists BEFORE spawn — simulates the portable logs dir
    // accumulating across runs. Its content has every keyword readiness
    // looks for; if the snapshot-of-new-files logic is missing, this file
    // would false-positive an early resolve.
    writeLog(
      "2026-08-04 11-00-00.txt",
      "Portable mode: true\n" +
        "[obs-websocket] Server started successfully on port 4466\n",
    );
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
      readinessTimeoutMs: 5_000,
    });
    // Let plenty of poll ticks pass without ever writing a NEW file.
    await vi.advanceTimersByTimeAsync(4_000);
    let settled = false;
    handle.ready.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false); // still pending — no false resolve

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(handle.ready).rejects.toThrow(/OBS 未产出日志/);
  });

  it("rejects with a message naming portable mode when the new log says Portable mode: false", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    writeLog("2026-08-04 12-21-00.txt", "Portable mode: false\n");
    await vi.advanceTimersByTimeAsync(600);
    await expect(handle.ready).rejects.toThrow(/便携/);
  });

  it("times out with the tail of the new log when new file appeared but keywords never showed up", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
      readinessTimeoutMs: 2_000,
    });
    writeLog("2026-08-04 12-21-00.txt", "some unrelated startup line\n");
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(handle.ready).rejects.toThrow(/unrelated startup line/);
  });

  it("incremental read: growing the new log across polls does not re-invoke onLogLine for already-seen lines", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    const seen: string[] = [];
    handle.onLogLine((line) => seen.push(line));

    writeLog("2026-08-04 12-21-00.txt", "line-1\n");
    await vi.advanceTimersByTimeAsync(600);
    appendLog("2026-08-04 12-21-00.txt", "line-2\n");
    await vi.advanceTimersByTimeAsync(600);
    appendLog(
      "2026-08-04 12-21-00.txt",
      "Portable mode: true\n[obs-websocket] Server started successfully on port 4466\n",
    );
    await vi.advanceTimersByTimeAsync(600);

    expect(seen).toEqual([
      "line-1",
      "line-2",
      "Portable mode: true",
      "[obs-websocket] Server started successfully on port 4466",
    ]);
    await expect(handle.ready).resolves.toEqual({
      wsUrl: "ws://127.0.0.1:4466",
    });
  });

  it("onLogLine's unsubscribe function stops further callbacks", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    const seen: string[] = [];
    const unsub = handle.onLogLine((line) => seen.push(line));
    writeLog("2026-08-04 12-21-00.txt", "line-1\n");
    await vi.advanceTimersByTimeAsync(600);
    unsub();
    appendLog("2026-08-04 12-21-00.txt", "line-2\n");
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual(["line-1"]);
  });

  it("uses the tolerant obs-websocket server-started regex, not just the literal line", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    writeLog(
      "2026-08-04 12-21-00.txt",
      "Portable mode: true\nobs-websocket: Server started on port 4466\n",
    );
    await vi.advanceTimersByTimeAsync(600);
    await expect(handle.ready).resolves.toEqual({
      wsUrl: "ws://127.0.0.1:4466",
    });
  });
});

describe("spawnManagedObs — exit safety", () => {
  it("does not throw when the underlying spawn emits 'error'", () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    expect(() => fakeChild.emit("error", new Error("ENOENT"))).not.toThrow();
    return expect(handle.ready).rejects.toThrow(/ENOENT/);
  });

  it("exited() reflects the fake child's exit event", () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    expect(handle.exited()).toBeNull();
    fakeChild.emit("exit", 0, null);
    expect(handle.exited()).toEqual({ code: 0, signal: null });
  });

  it("pid() returns the child's pid", () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    expect(handle.pid()).toBe(4242);
  });

  it("stop() calls child.kill() then, after 3s with no exit, escalates to killTreeImpl (taskkill /T /F)", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    const stopPromise = handle.stop();
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(killTreeImpl).toHaveBeenCalledWith(4242);
    fakeChild.emit("exit", 0, null);
    await stopPromise;
  });

  it("stop() resolves without escalating when the child exits within the grace period", async () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    const stopPromise = handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    fakeChild.emit("exit", 0, null);
    await stopPromise;
    expect(killTreeImpl).not.toHaveBeenCalled();
  });

  it("killSync() is synchronous, kills the child, and force-kills the tree without waiting", () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    handle.killSync();
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    expect(killTreeImpl).toHaveBeenCalledWith(4242);
  });

  it("killSync() is a no-op when the child has already exited", () => {
    const handle = spawnManagedObs({
      obsRoot,
      wsPort: 4466,
      spawnImpl,
      killTreeImpl,
    });
    fakeChild.emit("exit", 0, null);
    handle.killSync();
    expect(killTreeImpl).not.toHaveBeenCalled();
  });
});
