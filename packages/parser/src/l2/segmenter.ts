import type { ParsedLine } from "../l1/types";
import { Segment, ShuffleClose } from "./types";

/** 段生命周期事件(OBS 录像触发用):只在 IDLE↔open 真翻转时发,
 * shuffle 整个 lobby 一次,DOUBLE_START 换段不重发。 */
export interface SegmentOpenInfo {
  bracket: string;
  zoneId: string;
  isRated: boolean;
  /** 开场行 epoch ms。 */
  startTime: number;
}
export interface SegmentCloseInfo {
  /** ARENA_MATCH_END 行 epoch ms;异常闭合(end()/文件轮转)为 null。 */
  endTime: number | null;
  aborted: boolean;
}

export class Segmenter {
  private matchCallback?: (seg: Segment, end: ParsedLine) => void;
  private shuffleCallback?: (s: ShuffleClose) => void;
  private diagnosticCallback?: (d: { code: string; lineRef?: string }) => void;
  private openCallback?: (info: SegmentOpenInfo) => void;
  private closeCallback?: (info: SegmentCloseInfo) => void;

  private state: "IDLE" | "IN_MATCH" | "IN_SHUFFLE" = "IDLE";
  private currentSegment?: Segment;
  private rounds: Segment[] = [];

  public onMatch(cb: (seg: Segment, end: ParsedLine) => void): void {
    this.matchCallback = cb;
  }

  public onShuffle(cb: (s: ShuffleClose) => void): void {
    this.shuffleCallback = cb;
  }

  public onDiagnostic(
    cb: (d: { code: string; lineRef?: string }) => void,
  ): void {
    this.diagnosticCallback = cb;
  }

  public onOpen(cb: (info: SegmentOpenInfo) => void): void {
    this.openCallback = cb;
  }

  public onClose(cb: (info: SegmentCloseInfo) => void): void {
    this.closeCallback = cb;
  }

  private emitOpen(line: ParsedLine): void {
    this.openCallback?.({
      bracket: line.arenaStart?.bracket ?? "",
      zoneId: line.arenaStart?.zoneId ?? "",
      isRated: line.arenaStart?.isRated ?? false,
      startTime: line.timestamp,
    });
  }

  public push(line: ParsedLine, raw: string): void {
    if (line.eventName === "ARENA_MATCH_START") {
      const isShuffle = line.arenaStart?.bracket === "Rated Solo Shuffle";
      if (this.state === "IDLE") {
        if (isShuffle) {
          this.state = "IN_SHUFFLE";
          this.rounds = [];
          this.currentSegment = {
            kind: "shuffleRound",
            bracket: line.arenaStart?.bracket ?? "",
            zoneId: line.arenaStart?.zoneId ?? "",
            isRated: line.arenaStart?.isRated ?? false,
            startLine: line,
            records: [],
            rawLines: [raw],
            sequenceNumber: 0,
          };
        } else {
          this.state = "IN_MATCH";
          this.currentSegment = {
            kind: "match",
            bracket: line.arenaStart?.bracket ?? "",
            zoneId: line.arenaStart?.zoneId ?? "",
            isRated: line.arenaStart?.isRated ?? false,
            startLine: line,
            records: [],
            rawLines: [raw],
          };
        }
        this.emitOpen(line);
      } else if (this.state === "IN_MATCH") {
        this.diagnosticCallback?.({ code: "DOUBLE_START" });
        if (isShuffle) {
          this.state = "IN_SHUFFLE";
          this.rounds = [];
          this.currentSegment = {
            kind: "shuffleRound",
            bracket: line.arenaStart?.bracket ?? "",
            zoneId: line.arenaStart?.zoneId ?? "",
            isRated: line.arenaStart?.isRated ?? false,
            startLine: line,
            records: [],
            rawLines: [raw],
            sequenceNumber: 0,
          };
        } else {
          this.state = "IN_MATCH";
          this.currentSegment = {
            kind: "match",
            bracket: line.arenaStart?.bracket ?? "",
            zoneId: line.arenaStart?.zoneId ?? "",
            isRated: line.arenaStart?.isRated ?? false,
            startLine: line,
            records: [],
            rawLines: [raw],
          };
        }
      } else if (this.state === "IN_SHUFFLE") {
        if (this.currentSegment) {
          this.rounds.push(this.currentSegment);
        }
        this.currentSegment = {
          kind: "shuffleRound",
          bracket: line.arenaStart?.bracket ?? "",
          zoneId: line.arenaStart?.zoneId ?? "",
          isRated: line.arenaStart?.isRated ?? false,
          startLine: line,
          records: [],
          rawLines: [raw],
          sequenceNumber: this.rounds.length,
        };
      }
    } else if (line.eventName === "ARENA_MATCH_END") {
      if (this.state === "IN_MATCH") {
        if (this.currentSegment) {
          this.matchCallback?.(this.currentSegment, line);
        }
        this.state = "IDLE";
        this.currentSegment = undefined;
        this.closeCallback?.({ endTime: line.timestamp, aborted: false });
      } else if (this.state === "IN_SHUFFLE") {
        if (this.currentSegment) {
          this.rounds.push(this.currentSegment);
        }
        this.shuffleCallback?.({
          rounds: this.rounds,
          end: line,
        });
        this.state = "IDLE";
        this.currentSegment = undefined;
        this.rounds = [];
        this.closeCallback?.({ endTime: line.timestamp, aborted: false });
      } else {
        this.diagnosticCallback?.({ code: "ORPHAN_END" });
      }
    } else {
      if (this.state !== "IDLE" && this.currentSegment) {
        // records 与 rawLines 同步推进;lineIndex 必须等于 raw 即将落到的下标,
        // 这是事件 → raw.txt 行号深链(B2)的唯一对齐点。
        line.lineIndex = this.currentSegment.rawLines.length;
        this.currentSegment.records.push(line);
        this.currentSegment.rawLines.push(raw);
      }
    }
  }

  public end(): void {
    if (this.state !== "IDLE") {
      this.diagnosticCallback?.({ code: "UNCLOSED_SEGMENT" });
      this.state = "IDLE";
      this.currentSegment = undefined;
      this.rounds = [];
      this.closeCallback?.({ endTime: null, aborted: true });
    }
  }

  public hasOpenSegment(): boolean {
    return this.state !== "IDLE";
  }
}
