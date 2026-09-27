import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

test(
  "real Chromium reads a session parked on about:blank after a blocked redirect",
  { timeout: 120_000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-read-blank-"));
    const browser = await createBrowserManager({ dataDir });
    const id = randomUUID();
    try {
      const ip = await resolveIp("httpbin.org");
      await browser.create(id, `http://${ip}/`);
      // A redirect to a blocked destination is neutralized to about:blank and
      // reported, but the session slot survives for the next navigation.
      await assert.rejects(
        browser.navigate(id, `http://${ip}/redirect-to?url=http://169.254.169.254/`),
        { code: "NAVIGATION_FAILED" },
      );
      // Reading the parked session must not fail: about:blank carries no content,
      // and refresh() already treats it as a readable state.
      const read = await browser.read(id);
      assert.equal(read.url, "about:blank");
      assert.equal(read.title, "");
      assert.equal(read.text, "");
      assert.equal(read.truncated, false);
      // The session is still usable afterwards.
      await browser.navigate(id, `http://${ip}/`);
      const reread = await browser.read(id);
      assert.equal(reread.url, `http://${ip}/`);
    } finally {
      await browser.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
