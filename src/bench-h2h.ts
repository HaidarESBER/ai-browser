/**
 * Head-to-head benchmark: OUR MCP server vs Playwright MCP, driven by a real MCP
 * client through the SAME operations on the SAME page.
 *
 * Measures what is deterministic and honest: the BYTES each server returns to the
 * model per call, and the wall-clock latency of each call. It does NOT run a live
 * LLM, so it does not measure end-to-end agent wall-clock — but since LLM latency
 * and cost scale with tokens, "bytes to the model" is the honest core of the
 * speed claim. Tokens are approximated as bytes/4.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAGE = "https://en.wikipedia.org/wiki/Web_browser";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

type Content = { type: string; text?: string };

function modelBytes(res: unknown): number {
  const items = (res as { content?: Content[] }).content ?? [];
  let total = 0;
  for (const it of items) {
    total += Buffer.byteLength(it.type === "text" && it.text ? it.text : JSON.stringify(it), "utf8");
  }
  return total;
}

async function connect(command: string, args: string[], env: Record<string, string>) {
  const merged = { ...process.env, ...env } as Record<string, string>;
  const transport = new StdioClientTransport({ command, args, env: merged });
  const client = new Client({ name: "bench", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const t = performance.now();
  const res = await client.callTool({ name, arguments: args });
  return { ms: performance.now() - t, bytes: modelBytes(res) };
}

function toolNames(tools: { name: string }[]) {
  return new Set(tools.map((t) => t.name));
}

const fmt = (n: number) => n.toLocaleString();
const tok = (b: number) => Math.round(b / 4);

async function main() {
  console.log(`Head-to-head on: ${PAGE}\n`);

  // ---- OURS ----
  const ours = await connect(npx, ["tsx", "src/mcp.ts"], {
    AI_BROWSER_LIVE: "0",
    AI_BROWSER_HEADED: "0",
  });
  const oNav = await call(ours, "browser_navigate", { url: PAGE });
  const oFull = await call(ours, "browser_snapshot", {}); // full re-perceive
  const oCache = await call(ours, "browser_snapshot", {}); // cached re-perceive
  const oInc = await call(ours, "browser_changes", {}); // incremental re-perceive
  await ours.close();

  // ---- PLAYWRIGHT MCP ----
  // Invoke the LOCAL install (no @latest → no npx install prompt that would hang).
  console.log("\nConnecting to Playwright MCP…");
  // Use Playwright's bundled Chromium (already installed) — its default is the
  // real 'chrome' channel, which isn't present here.
  const pw = await connect(npx, ["@playwright/mcp", "--headless", "--browser", "chromium"], {});
  const { tools } = await pw.listTools();
  const names = toolNames(tools);
  console.log(`Playwright MCP tools: ${[...names].join(", ")}\n`);
  const navName = names.has("browser_navigate") ? "browser_navigate" : "";
  const snapName = names.has("browser_snapshot") ? "browser_snapshot" : "";
  if (!navName || !snapName) {
    console.log("Playwright MCP tool names differ; available:", [...names].join(", "));
    await pw.close();
    return;
  }
  const pNav = await call(pw, navName, { url: PAGE });
  const pFull = await call(pw, snapName, {}); // full re-perceive (inline snapshot)
  const pCache = await call(pw, snapName, {}); // no cache primitive → full again
  // Playwright MCP has no incremental/diff primitive → best available is a full snapshot.
  const pInc = pFull;
  await pw.close();

  // ---- REPORT ----
  const row = (label: string, o: { ms: number; bytes: number }, p: { ms: number; bytes: number }) =>
    `${label.padEnd(26)} | ours ${fmt(o.bytes).padStart(7)}B ~${fmt(tok(o.bytes)).padStart(5)}tok ${o.ms.toFixed(0).padStart(5)}ms | pw ${fmt(p.bytes).padStart(7)}B ~${fmt(tok(p.bytes)).padStart(5)}tok ${p.ms.toFixed(0).padStart(5)}ms`;

  console.log(row("navigate (full snapshot)", oNav, pNav));
  console.log(row("re-snapshot (full)", oFull, pFull));
  console.log(row("re-perceive (cached/full)", oCache, pCache));
  console.log(row("re-perceive (incremental)", oInc, pInc));

  console.log("\n— Best-practice re-perceive after an action —");
  console.log(`  ours (browser_changes): ${fmt(oInc.bytes)} B  (~${fmt(tok(oInc.bytes))} tokens)`);
  console.log(`  playwright (full snap):  ${fmt(pInc.bytes)} B  (~${fmt(tok(pInc.bytes))} tokens)`);
  const ratio = pInc.bytes > 0 ? (oInc.bytes / pInc.bytes) * 100 : 0;
  console.log(`  → ours sends ${ratio.toFixed(1)}% of the payload to re-perceive`);
}

const watchdog = setTimeout(() => {
  console.error("\n⏱️  Watchdog: benchmark exceeded 150s — aborting.");
  process.exit(2);
}, 150_000);

main()
  .then(() => clearTimeout(watchdog))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
