/**
 * MCP-level regression tests: spawn the server as a client would and drive it
 * against a local fixture site.
 * Run with: npm run regress:mcp
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pages: Record<string, string> = {
  "/": `<a href="/docs" target=_blank>Open docs</a>`,
  "/docs": `<title>Docs</title><button>Read more</button>`,
  "/slow": `<button id=b onclick="window.bought=(window.bought||0)+1">Buy</button>`,
};
const site = createServer((req, res) => {
  const body = pages[(req.url ?? "/").split("?")[0]!];
  res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "text/html" });
  res.end(body ?? "not found");
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/mcp.ts"],
  env: { ...process.env, AI_BROWSER_LIVE: "0", AI_BROWSER_TOOL_TIMEOUT_MS: "3000" } as Record<string, string>,
});
const client = new Client({ name: "mcp-regress", version: "0.0.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return { text: res.content.map((c) => c.text ?? `<${c.type}>`).join("\n"), res };
};
const idOf = (snapshot: string, name: string) => {
  const m = new RegExp(`\\[(e\\d+)\\][^\\n]*name="${name}"`).exec(snapshot);
  assert.ok(m, `no element named ${name} in:\n${snapshot}`);
  return m[1]!;
};

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

try {
  console.log("tabs:");

  await check("clicking a target=_blank link switches to the new tab", async () => {
    const nav = await call("browser_navigate", { url: base + "/" });
    const click = await call("browser_click", { id: idOf(nav.text, "Open docs") });
    assert.match(click.text, /Switched to the new tab/);
    assert.match(click.text, /name="Read more"/);
    const tabs = await call("browser_tabs");
    assert.match(tabs.text, /\* \[1\] Docs/);
    const back = await call("browser_switch_tab", { index: 0 });
    assert.match(back.text, /name="Open docs"/);
  });

  console.log("\ntimeouts:");

  await check("a timed-out click is cancelled, not left running", async () => {
    const nav = await call("browser_navigate", { url: base + "/slow" });
    const id = idOf(nav.text, "Buy");
    // Hide the button, and bring it back after the tool has already timed out.
    await call("browser_evaluate", {
      js: "(b.style.display='none', setTimeout(() => b.style.display='', 3500), 1)",
    });
    const t = Date.now();
    const click = await call("browser_click", { id });
    assert.equal(click.res.isError, true, click.text);
    assert.match(click.text, /timed out after 3000ms; the action was cancelled/);
    // The abandoned click must not land later on.
    await new Promise((r) => setTimeout(r, Math.max(0, 9000 - (Date.now() - t))));
    const bought = await call("browser_evaluate", { js: "window.bought ?? 0" });
    assert.equal(bought.text, "0");
  });
} finally {
  await client.close();
  site.close();
}
console.log(`\n✅ ${passed} MCP regression tests passed.`);
