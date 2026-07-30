import { describe, expect, it } from "vitest";
import {
  detectObsWebsocket,
  obsWebsocketConfigCandidates,
} from "./obsAutoConfig";

describe("obsWebsocketConfigCandidates", () => {
  it("win32 走 APPDATA;darwin 走 Application Support;无 APPDATA → 空", () => {
    expect(
      obsWebsocketConfigCandidates({
        platform: "win32",
        appData: "C:\\Users\\me\\AppData\\Roaming",
      })[0],
    ).toContain("obs-websocket");
    expect(
      obsWebsocketConfigCandidates({ platform: "win32", appData: undefined }),
    ).toEqual([]);
    expect(
      obsWebsocketConfigCandidates({
        platform: "darwin",
        home: "/Users/me",
      })[0],
    ).toContain("Application Support");
  });
});

describe("detectObsWebsocket", () => {
  const cfg = (o: object) => JSON.stringify(o);

  it("解析端口/密码/启用位;auth 关闭时密码视为 null", () => {
    const d = detectObsWebsocket(["/fake/config.json"], () =>
      cfg({
        server_enabled: true,
        auth_required: true,
        server_port: 4466,
        server_password: "pw",
      }),
    );
    expect(d).toMatchObject({
      found: true,
      enabled: true,
      authRequired: true,
      port: 4466,
      password: "pw",
    });
    const noAuth = detectObsWebsocket(["/fake/config.json"], () =>
      cfg({ server_enabled: true, auth_required: false, server_port: 4455 }),
    );
    expect(noAuth.authRequired).toBe(false);
  });

  it("文件不存在/损坏 → found:false;服务器未启用如实上报", () => {
    expect(
      detectObsWebsocket(["/nope"], () => {
        throw new Error("ENOENT");
      }).found,
    ).toBe(false);
    expect(detectObsWebsocket(["/bad"], () => "{not json").found).toBe(false);
    expect(
      detectObsWebsocket(["/fake"], () =>
        cfg({ server_enabled: false, server_port: 4455 }),
      ),
    ).toMatchObject({ found: true, enabled: false });
  });
});
