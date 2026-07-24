/**
 * Smoke test: spawn the MCP server as a real MCP client would, list its tools,
 * and call a couple — proving the server works end to end.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.[0]?.text ?? "(no text)";
}

async function main() {
  // Spawn node itself (with tsx as a loader) rather than npx: on Windows, closing
  // the client killed only the npx.cmd wrapper, leaving the server — and its
  // Chromium — running, so this script never exited.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp.ts"],
  });

  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`\n🔌 Connected. Server exposes ${tools.length} tools:`);
  for (const t of tools) console.log(`  • ${t.name} — ${t.description}`);

  console.log("\n▶ Calling browser_navigate(https://example.com)…");
  const nav = await client.callTool({
    name: "browser_navigate",
    arguments: { url: "https://example.com" },
  });
  console.log(firstText(nav));

  console.log("\n▶ Calling browser_find('more')…");
  const found = await client.callTool({
    name: "browser_find",
    arguments: { query: "more" },
  });
  console.log(firstText(found));

  console.log("\n▶ Calling browser_click(e0)…  (diff-by-default response)");
  const click = await client.callTool({
    name: "browser_click",
    arguments: { id: "e0" },
  });
  console.log(firstText(click));

  await client.close();
  console.log("\n✅ MCP smoke test complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
