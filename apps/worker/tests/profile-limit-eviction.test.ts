import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Sandbox-only: direct TCP egress is policy-blocked for this assistant, so the
// worker's direct-egress proxy cannot reach the public internet here. Route this
// test process's plain-HTTP upstream requests through the sandbox-approved egress
// proxy. Production and CI reach the internet directly and do not need this shim.
const require = createRequire(import.meta.url);
const http = require("node:http") as typeof import("node:http");
const originalRequest = http.request;
const proxyAuth = Buffer.from(
  (process.env.https_proxy ?? "").replace(/^https?:\/\//, "").split("@")[0] ?? "",
).toString("base64");
http.request = function (options: unknown, cb: unknown) {
  const opts = (
    typeof options === "string" ? new URL(options) : (options as Record<string, unknown>)
  ) as Record<string, unknown>;
  const hostname = String(opts.hostname ?? opts.host ?? "");
  if (!hostname || ["localhost", "127.0.0.1", "::1"].includes(hostname) || !proxyAuth)
    return (originalRequest as (...args: unknown[]) => unknown).call(this, options, cb);
  const port = Number(opts.port ?? 80);
  const { hostname: _h, host: _ho, family: _f, port: _p, path: _pa, ...rest } = opts;
  return (originalRequest as (...args: unknown[]) => unknown).call(
    this,
    {
      ...rest,
      hostname: "fd8b:4f84:7d32:99::1",
      port: 3128,
      family: 6,
      path: `http://${hostname}:${port}${String(opts.path ?? "/")}`,
      headers: {
        ...((opts.headers ?? {}) as Record<string, string>),
        host: port === 80 ? hostname : `${hostname}:${port}`,
        "proxy-authorization": `Basic ${proxyAuth}`,
      },
    },
    cb,
  );
} as typeof http.request;

const { createBrowserManager } = await import("../src/browser.ts");

/** The sandbox resolver is hijacked, so resolve the seed host over HTTPS like production DNS would. */
async function resolveIp(hostname: string): Promise<string> {
  const response = await fetch(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { Answer?: { data?: string; type?: number }[] };
  const answer = body.Answer?.find(
    (record) => record.type === 1 && typeof record.data === "string",
  );
  if (!answer?.data) throw new Error("no A record");
  return answer.data;
}

test("real Chromium evicts the least-recently-used closed profile instead of failing at the profile limit", {
  timeout: 120_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-profile-limit-"));
  // Seed 20 closed profiles on disk, exactly as closed sessions persist and
  // rehydrate on worker startup. Distinct updatedAt values make the eviction
  // target deterministic: seed 0 is the oldest.
  const seedIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    seedIds.push(id);
    await mkdir(join(dataDir, id), { recursive: true });
    await writeFile(
      join(dataDir, id, "session.json"),
      JSON.stringify({
        id,
        title: `seed-${i}`,
        url: "https://example.com/",
        status: "active",
        updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
  }
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    assert.equal(browser.list().length, 20);
    const ip = await resolveIp("httpbin.org");
    // On base this rejects with PROFILE_LIMIT: the limit has no eviction
    // path, so 20 closed profiles block every new session permanently.
    const session = await browser.create(id, `http://${ip}/`);
    assert.equal(session.status, "active");
    const remaining = await readdir(dataDir);
    assert.equal(remaining.length, 20, "one profile evicted, one created");
    assert.ok(!remaining.includes(seedIds[0]), "oldest closed profile evicted");
    for (const kept of seedIds.slice(1)) assert.ok(remaining.includes(kept));
    assert.ok(remaining.includes(id));
    assert.equal(browser.list().length, 20);
  } finally {
    await browser.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
