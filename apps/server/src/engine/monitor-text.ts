import { createHash } from "node:crypto";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export interface MonitorTextCache {
  rawHash: string;
  hash: string;
  prefix: string;
}

// Normalize a monitor observation for change detection. Whitespace
// normalization is O(n) and dominates the tick's CPU budget on large pages,
// but when the raw bytes are byte-identical to the previous check the
// normalized text and its hash are necessarily identical too, so the cached
// values are reused and the normalization is skipped entirely.
export function dedupeMonitorText(
  rawText: string,
  previous?: MonitorTextCache,
): { text: string; hash: string; rawHash: string; reused: boolean } {
  const rawHash = hash(rawText);
  if (previous && previous.rawHash === rawHash) {
    return { text: previous.prefix, hash: previous.hash, rawHash, reused: true };
  }
  const text = rawText.replace(/\s+/g, " ").trim();
  return { text, hash: hash(text), rawHash, reused: false };
}
