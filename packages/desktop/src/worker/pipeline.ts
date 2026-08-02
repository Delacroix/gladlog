import { GladLogParser } from "@gladlog/parser";
import type { FileCheckpoint, WorkerToMain } from "../shared/protocol";
import { initialTailState, readTail, type TailState } from "./tailReader";

export interface ParserLike {
  push(line: string): void;
  end(): void;
  hasOpenSegment(): boolean;
  on(
    event: "match" | "shuffle" | "diagnostic" | "segmentOpen" | "segmentClose",
    cb: (payload: never) => void,
  ): unknown;
}

export class FilePipeline {
  private parser!: ParserLike;
  private tail: TailState;
  private cp: FileCheckpoint;
  private readonly fileKey: string;
  private readonly filePath: string;
  private readonly emit: (msg: WorkerToMain) => void;
  private readonly parserFactory: () => ParserLike;

  constructor(opts: {
    fileKey: string;
    filePath: string;
    checkpoint: FileCheckpoint | null;
    emit: (msg: WorkerToMain) => void;
    parserFactory?: () => ParserLike;
  }) {
    this.fileKey = opts.fileKey;
    this.filePath = opts.filePath;
    this.emit = opts.emit;
    this.parserFactory =
      opts.parserFactory ??
      (() => new GladLogParser() as unknown as ParserLike);
    this.cp = opts.checkpoint ?? { offset: 0, firstLineChecksum: null };
    this.tail = initialTailState(this.cp);
    this.createParser();
  }

  private createParser(): void {
    this.parser = this.parserFactory();
    this.parser.on("match", (payload) =>
      this.emit({
        type: "match",
        fileKey: this.fileKey,
        payload: payload as never,
      }),
    );
    this.parser.on("shuffle", (payload) =>
      this.emit({
        type: "shuffle",
        fileKey: this.fileKey,
        payload: payload as never,
      }),
    );
    this.parser.on("segmentOpen", (payload) => {
      const i = payload as {
        bracket: string;
        zoneId: string;
        isRated: boolean;
        startTime: number;
      };
      this.emit({ type: "segmentOpen", fileKey: this.fileKey, ...i });
    });
    this.parser.on("segmentClose", (payload) => {
      const i = payload as { endTime: number | null; aborted: boolean };
      this.emit({ type: "segmentClose", fileKey: this.fileKey, ...i });
    });
    this.parser.on("diagnostic", (payload) => {
      const d = payload as { code: string; lineRef?: string };
      this.emit({
        type: "diagnostic",
        fileKey: this.fileKey,
        code: d.code,
        detail: d.lineRef,
      });
    });
  }

  processFlush(): void {
    const r = readTail(this.filePath, this.tail);
    if (r.rotated) {
      // 轮转丢弃旧 parser:对局进行中的话,录像侧必须收到闭合信号,
      // 否则 recorder 只能等 40 分钟安全阀。
      if (this.parser.hasOpenSegment()) {
        this.emit({
          type: "segmentClose",
          fileKey: this.fileKey,
          endTime: null,
          aborted: true,
        });
      }
      this.createParser();
      this.cp = { offset: 0, firstLineChecksum: r.state.firstLineChecksum };
    }
    for (const line of r.lines) this.parser.push(line);
    this.tail = r.state;
    if (!this.parser.hasOpenSegment()) {
      this.cp = {
        offset: this.tail.offset,
        firstLineChecksum: this.tail.firstLineChecksum,
      };
    }
  }

  /** teardown(换目录/重配)前调用:对局进行中的话给录像侧补闭合信号,
   * 否则 recorder 只能等 40 分钟安全阀(agy flash 复核 #5)。 */
  closeOpenSegment(): void {
    if (this.parser.hasOpenSegment()) {
      this.emit({
        type: "segmentClose",
        fileKey: this.fileKey,
        endTime: null,
        aborted: true,
      });
    }
  }

  get checkpoint(): FileCheckpoint {
    return this.cp;
  }
  get currentOffset(): number {
    return this.tail.offset;
  }
  /** 段静默阀(runtime)用:是否有对局段开着。 */
  get hasOpenSegment(): boolean {
    return this.parser.hasOpenSegment();
  }
}
