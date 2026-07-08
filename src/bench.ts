/**
 * Internal micro-benchmark: measures the M4 speed features (cache + diff) on a
 * content-heavy page. NOT a competitor comparison — just honest numbers on what
 * caching and diff-based perception actually save.
 */
import { AIBrowser } from "./browser.js";

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o), "utf8");

async function main() {
  const browser = await AIBrowser.launch({ headless: true });
  const page = await browser.newPage();
  const url = "https://en.wikipedia.org/wiki/Web_browser";

  await page.goto(url);
  await page.waitUntilReady();

  // Full snapshot (cold): walks the DOM + serializes everything.
  let t = performance.now();
  const full = await page.snapshot();
  const fullMs = performance.now() - t;

  await page.snapshot({ cache: true }); // prime the cache

  // Cached snapshot (warm): only a cheap DOM-version read, no walk/serialize.
  t = performance.now();
  await page.snapshot({ cache: true });
  const cachedMs = performance.now() - t;

  // One small DOM change, then ask only for the delta.
  await page.evaluate(
    "document.body.insertAdjacentHTML('afterbegin', '<a href=\"#\">Bench Added Link</a>')",
  );
  t = performance.now();
  const diff = await page.changes();
  const diffMs = performance.now() - t;

  const fullBytes = bytes(full.elements);
  const diffBytes = bytes(diff);

  console.log(`\nPage: ${url}`);
  console.log(`Interactive elements: ${full.elements.length}\n`);
  console.log(`Full snapshot   : ${fullMs.toFixed(1).padStart(6)} ms   ${fullBytes} bytes`);
  console.log(`Cached snapshot : ${cachedMs.toFixed(1).padStart(6)} ms   (no DOM walk, no serialization)`);
  console.log(`Diff (1 added)  : ${diffMs.toFixed(1).padStart(6)} ms   ${diffBytes} bytes payload`);
  console.log("");
  console.log(`→ cache latency : ${(fullMs / Math.max(cachedMs, 0.01)).toFixed(1)}x faster than a full snapshot`);
  console.log(`→ diff payload  : ${((diffBytes / fullBytes) * 100).toFixed(1)}% the size of a full snapshot sent to the model`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
