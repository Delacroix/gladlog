import { slimStoredDoc } from "./slimDoc";

/**
 * Consumer-side parsing for direct doc-byte transfer (2026-07-26): main's
 * matches:get returns only the raw bytes and the parse happens in preload
 * (same process and heap as the renderer) -- so a doc is materialized exactly
 * once across the whole chain. The slim fallback runs the shared predicate:
 * the local library has been fully migrated to slim, but a foreign legacy fat
 * doc is still fat bytes on its first open before background self-healing
 * completes, and what the product shows must match the old path (slimmed on
 * the main side before sending); it is idempotent and a no-op on slim docs.
 *
 * Lives in shared: preload consumes it, and tests deep-equal it against the
 * old pipeline directly.
 */
/** Buffer (same-process) / Uint8Array (IPC structured clone) → utf-8 text.
 * Exported so the lazy per-round path (parseLazyDoc) decodes bytes with the
 * exact same predicate. */
export function docBytesToText(buf: unknown): string {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(buf)
    ? buf.toString("utf-8")
    : new TextDecoder().decode(buf as ArrayBuffer | Uint8Array);
}

export function parseDocBytes(buf: unknown): unknown | null {
  if (buf == null) return null;
  try {
    const text = docBytesToText(buf);
    // A corrupt / half-written match.json: the old pipeline (try/catch on the
    // worker side) returns null, and the semantics here are the same --
    // throwing would surface as an unhandled rejection in the renderer
    // (agy F2).
    const doc: unknown = JSON.parse(text);
    try {
      slimStoredDoc(doc);
    } catch {
      /* A failed fallback must not block loading */
    }
    return doc;
  } catch {
    return null;
  }
}
