import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeMonitorText } from "../apps/server/src/engine/monitor-text.ts";

test("dedupeMonitorText normalizes and hashes on the first observation", () => {
  const result = dedupeMonitorText("hello\n\n  world  ");
  assert.equal(result.reused, false);
  assert.equal(result.text, "hello world");
  assert.match(result.rawHash, /^[0-9a-f]{64}$/);
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(result.rawHash, result.hash);
});

test("dedupeMonitorText reuses the cached values when the raw bytes are identical", () => {
  const raw = "a  b\nc ".repeat(1000);
  const first = dedupeMonitorText(raw);
  assert.equal(first.reused, false);
  const second = dedupeMonitorText(raw, {
    rawHash: first.rawHash,
    hash: first.hash,
    prefix: first.text.slice(0, 1000),
  });
  assert.equal(second.reused, true);
  assert.equal(second.hash, first.hash);
  assert.equal(second.text, first.text.slice(0, 1000));
});

test("dedupeMonitorText treats whitespace-only changes as the same normalized hash", () => {
  const first = dedupeMonitorText("price:  $42\nin stock");
  const second = dedupeMonitorText("price: $42 in    stock", {
    rawHash: first.rawHash,
    hash: first.hash,
    prefix: first.text.slice(0, 1000),
  });
  assert.equal(second.reused, false, "raw bytes changed, so the cache cannot be reused");
  assert.equal(second.hash, first.hash, "whitespace-only edits must not count as a change");
});

test("dedupeMonitorText reports a new hash when the content changes", () => {
  const first = dedupeMonitorText("price: $42");
  const second = dedupeMonitorText("price: $43", {
    rawHash: first.rawHash,
    hash: first.hash,
    prefix: first.text.slice(0, 1000),
  });
  assert.equal(second.reused, false);
  assert.notEqual(second.hash, first.hash);
});

test("dedupeMonitorText ignores a stale cache entry", () => {
  const first = dedupeMonitorText("one");
  const second = dedupeMonitorText("two", {
    rawHash: "0".repeat(64),
    hash: first.hash,
    prefix: "stale",
  });
  assert.equal(second.reused, false);
  assert.equal(second.text, "two");
});
