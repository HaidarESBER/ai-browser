/**
 * Smoke test for the live view (M5): drive a headless page, start the live
 * server, and verify the /frame (screenshot) and /events (trace) endpoints work.
 */
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

  const frame = await fetch(`${url}/frame`);
  const bytes = Buffer.from(await frame.arrayBuffer());
  console.log(`   GET /frame  → ${frame.status} ${frame.headers.get("content-type")} (${bytes.length} bytes)`);

  const events = await fetch(`${url}/events`);
  const trace = (await events.json()) as { kind: string; detail: string }[];
  console.log(`   GET /events → ${events.status} (${trace.length} trace events)`);
  for (const e of trace) console.log(`     • [${e.kind}] ${e.detail}`);

  const ok = frame.status === 200 && bytes.length > 0 && events.status === 200 && trace.length > 0;

  await live.stop();
  await browser.close();
  console.log(ok ? "\n✅ Live-view smoke passed." : "\n❌ Live-view smoke failed.");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
