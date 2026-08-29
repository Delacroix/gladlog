import { readFileSync } from "fs";

import { atomicWriteFileSync } from "../shared/atomicWrite";
import type { FileCheckpoint } from "../shared/protocol";

export interface CheckpointRegistry {
  files: Record<string, FileCheckpoint>;
}

export function loadCheckpoints(path: string): CheckpointRegistry {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as CheckpointRegistry;
    return parsed && typeof parsed.files === "object" && parsed.files !== null
      ? parsed
      : { files: {} };
  } catch {
    return { files: {} };
  }
}

export function saveCheckpoints(path: string, reg: CheckpointRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(reg, null, 2));
}
