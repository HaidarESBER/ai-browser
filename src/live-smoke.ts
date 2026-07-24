/**
 * Smoke test for the live view (M5): drive a headless page, start the live
 * server, and verify the /frame (screenshot) and /events (trace) endpoints work.
 */
import http from "node:http";
import { AIBrowser } from "./browser.js";
import { LiveView } from "./live.js";

async function main() {
  const browser = await AIBrowser.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto("https://example.com");
  await page.waitUntilReady();
  const snap = await page.snapshot();
  if (snap.elements[0]) await page.clickById(snap.elements[0].id);

  const live = new LiveView(page);
  const url = await live.start();
  console.log(`\n🖥️  Live view started at ${url}`);

  const at = (path: string) => {
    const u = new URL(url);
    u.pathname = path;
    return u.href;
  };
  const frame = await fetch(at("/frame"));
  const bytes = Buffer.from(await frame.arrayBuffer());
  console.log(`   GET /frame  → ${frame.status} ${frame.headers.get("content-type")} (${bytes.length} bytes)`);

  const events = await fetch(at("/events"));
  const trace = (await events.json()) as { kind: string; detail: string }[];
  console.log(`   GET /events → ${events.status} (${trace.length} trace events)`);
  for (const e of trace) console.log(`     • [${e.kind}] ${e.detail}`);

  // Locked down: no token, or a foreign Host header (DNS rebinding), is refused.
  const noToken = await fetch(at("/frame").split("?")[0]!);
  console.log(`   GET /frame without token → ${noToken.status}`);
  const port = new URL(url).port;
  const rebound = await new Promise<number>((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: `/frame?token=${live.token}`, headers: { Host: `evil.example:${port}` } },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on("error", () => resolve(0));
  });
  console.log(`   GET /frame with Host: evil.example → ${rebound}`);

  const ok =
    frame.status === 200 &&
    bytes.length > 0 &&
    events.status === 200 &&
    trace.length > 0 &&
    noToken.status === 403 &&
    rebound === 403;

  await live.stop();
  await browser.close();
  console.log(ok ? "\n✅ Live-view smoke passed." : "\n❌ Live-view smoke failed.");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
