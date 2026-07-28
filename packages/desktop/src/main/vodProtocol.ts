import { protocol } from "electron";
import { createReadStream, statSync } from "fs";
import { extname } from "path";
import { Readable } from "stream";
import { parseRange, vodUrlToPath, VOD_SCHEME } from "../shared/vod";

/** 必须在 app ready 前调用(index.ts 模块顶层)。 */
export function registerVodScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VOD_SCHEME,
      privileges: {
        standard: true,
        stream: true,
        supportFetchAPI: true,
        bypassCSP: true,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
};

/** whenReady 里调用。isServable 只放行录像索引认识的文件 —— 特权协议
 * 绝不能变成任意本地文件读取口。 */
export function handleVodProtocol(isServable: (path: string) => boolean): void {
  protocol.handle(VOD_SCHEME, (req) => {
    try {
      const path = vodUrlToPath(req.url);
      if (!path || !isServable(path))
        return new Response("forbidden", { status: 403 });
      const size = statSync(path).size;
      const range = parseRange(req.headers.get("range"), size);
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      const stream = Readable.toWeb(
        createReadStream(path, { start, end }),
      ) as ReadableStream;
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          "content-type": MIME[extname(path).toLowerCase()] ?? "video/mp4",
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
          ...(range
            ? { "content-range": `bytes ${start}-${end}/${size}` }
            : {}),
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
