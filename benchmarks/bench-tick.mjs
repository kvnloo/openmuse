/**
 * Bench 2: monitor observe() tick text-processing cost vs. page text size.
 *
 * Exact code from EngineService.observe() in apps/server/src/engine/service.ts
 * (CopilotKit/openmuse main @ f5534c7), lines ~925-928:
 *
 *   const text = observation.text.replace(/\s+/g, " ").trim();
 *   const currentHash = hash(text);   // sha256 hex
 *
 * This runs on the FULL page text on EVERY monitor check, before hashing for
 * change detection. Variants:
 *   current  - normalize full text, then sha256 (what ships)
 *   hashOnly - sha256 of raw text (measures the normalization share; semantic
 *              change — whitespace-insensitive detection is a feature — so this
 *              is a CEILING on avoidable cost, not a proposal)
 * Also splits current into normalize vs trim vs hash to show the breakdown.
 *
 * Synthetic page text: HN-style lines with realistic whitespace runs.
 */
import { createHash } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");

function makePage(bytes) {
  const words = ["the", "quick", "brown", "fox", "Hacker", "News", "comments", "thread", "update", "release", "version", "benchmark", "agent", "browser", "server"];
  const chunks = [];
  let n = 0;
  let i = 0;
  while (n < bytes) {
    const line = Array.from({ length: 12 }, () => words[(i * 7 + chunks.length) % words.length]).join(" ");
    // realistic whitespace: indentation, blank lines, trailing spaces
    const ws = i % 5 === 0 ? "\n\n    " : i % 3 === 0 ? "  \n" : "\n";
    const piece = line + ws;
    chunks.push(piece);
    n += piece.length;
    i++;
  }
  return chunks.join("").slice(0, bytes);
}

function bench(name, fn, input, iters) {
  for (let i = 0; i < 5; i++) fn(input); // warm-up
  const ts = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn(input);
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  const p95 = ts[Math.floor(ts.length * 0.95)];
  return { name, medianMs: +med.toFixed(3), p95Ms: +p95.toFixed(3) };
}

const current = (t) => hash(t.replace(/\s+/g, " ").trim());
const hashOnly = (t) => hash(t);
const normalizeOnly = (t) => t.replace(/\s+/g, " ").trim();

const results = [];
for (const kb of [50, 500, 2000, 5000]) {
  const page = makePage(kb * 1024);
  const iters = kb <= 500 ? 60 : 20;
  // correctness: both variants deterministic; hashOnly differs by design (whitespace)
  const a = current(page), b = current(page);
  if (a !== b) throw new Error("nondeterministic current()");
  results.push({
    pageKB: kb,
    variants: [
      bench("current(normalize+sha256)", current, page, iters),
      bench("normalizeOnly", normalizeOnly, page, iters),
      bench("hashOnly(raw,ceiling)", hashOnly, page, iters),
    ],
  });
}
console.log(JSON.stringify(results, null, 1));
console.log("ENV", JSON.stringify({ node: process.version, warmups: 5, metric: "ms per tick text-processing" }));
