import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  loadWindowState,
  MIN_WINDOW,
  saveWindowState,
  type WindowState,
} from "./windowState";

const tmpFile = () =>
  join(mkdtempSync(join(tmpdir(), "glad-winstate-")), "window-state.json");

describe("windowState", () => {
  it("首启无档返回 null", () => {
    expect(loadWindowState(tmpFile())).toBeNull();
  });

  it("save → load 往返保真(含位置与最大化)", () => {
    const p = tmpFile();
    const s: WindowState = {
      width: 1728,
      height: 1050,
      x: 40,
      y: 25,
      maximized: true,
    };
    saveWindowState(p, s);
    expect(loadWindowState(p)).toEqual(s);
  });

  it("无 x/y 的档读回也无 x/y(交系统居中)", () => {
    const p = tmpFile();
    saveWindowState(p, { width: 1600, height: 1000, maximized: false });
    const got = loadWindowState(p)!;
    expect(got.x).toBeUndefined();
    expect(got.y).toBeUndefined();
  });

  it("损坏 JSON / 非对象 / 缺尺寸字段 → null", () => {
    const p1 = tmpFile();
    writeFileSync(p1, "{not json");
    expect(loadWindowState(p1)).toBeNull();
    const p2 = tmpFile();
    writeFileSync(p2, JSON.stringify([1, 2]));
    expect(loadWindowState(p2)).toBeNull();
    const p3 = tmpFile();
    writeFileSync(p3, JSON.stringify({ width: 1600 }));
    expect(loadWindowState(p3)).toBeNull();
    const p4 = tmpFile();
    writeFileSync(p4, JSON.stringify({ width: "1600", height: 900 }));
    expect(loadWindowState(p4)).toBeNull();
  });

  it("尺寸低于 minWidth/minHeight 时钳到下限(手改档/旧屏迁移)", () => {
    const p = tmpFile();
    writeFileSync(
      p,
      JSON.stringify({ width: 300, height: 200, maximized: false }),
    );
    const got = loadWindowState(p)!;
    expect(got.width).toBe(MIN_WINDOW.width);
    expect(got.height).toBe(MIN_WINDOW.height);
  });

  it("非有限数(NaN/Infinity 序列化成 null)不炸、按缺字段处理", () => {
    const p = tmpFile();
    writeFileSync(
      p,
      JSON.stringify({ width: null, height: 900, maximized: false }),
    );
    expect(loadWindowState(p)).toBeNull();
  });

  it("写入是原子替换:目标文件始终是完整 JSON", () => {
    const p = tmpFile();
    saveWindowState(p, { width: 1600, height: 1000, maximized: false });
    saveWindowState(p, { width: 1920, height: 1080, maximized: false });
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.width).toBe(1920);
  });
});
