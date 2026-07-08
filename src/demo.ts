/**
 * AI-Native Browser Framework — engine demo
 *
 * Exercises the capability surface (src/browser.ts) with the reliability layer:
 *   See · Check · Navigate · Interact · Extract · Correct (verify + retry + heal)
 */
import { AIBrowser, type AIPage } from "./browser.js";

/** A self-contained page (no external site needed) that logs to the console. */
const FIXTURE =
  "data:text/html," +
  encodeURIComponent(`
    <!doctype html><html><body>
      <h1>Demo Form</h1>
      <input id="q" placeholder="Search query" />
      <button id="go" onclick="console.log('submitted: ' + document.getElementById('q').value)">
        Search
      </button>
      <a href="https://example.com">A link</a>
      <script>console.log('fixture page loaded');</script>
    </body></html>`);

function printSnapshot(
  label: string,
  elements: { id: string; tag: string; role: string; name: string; value?: string }[],
) {
  console.log(`\n📄 ${label}`);
  for (const el of elements) {
    const val = el.value ? ` value="${el.value}"` : "";
    console.log(`  [${el.id}] <${el.tag}> role=${el.role} name="${el.name}"${val}`);
  }
}

async function demoInteractAndCheck(page: AIPage) {
  console.log("\n=== Part 1: Interact + Check + self-verifying actions ===");
  await page.goto(FIXTURE);
  await page.waitUntilReady();

  const snap = await page.snapshot();
  printSnapshot("Fixture loaded", snap.elements);

  const input = snap.elements.find((e) => e.tag === "input");
  const button = snap.elements.find((e) => e.tag === "button");
  if (input && button) {
    const typed = await page.typeById(input.id, "hello ai browser");
    console.log(`\n⌨️  ${typed.detail}`); // typeById verifies the value actually landed
    const clicked = await page.clickById(button.id);
    console.log(`🖱️  ${clicked.detail}`);
  }

  console.log("\n🔎 Console captured:");
  for (const entry of page.console()) console.log(`  [${entry.type}] ${entry.text}`);
}

async function demoNavigateAndExtract(page: AIPage) {
  console.log("\n=== Part 2: Navigate + verified effect + extract ===");
  page.clearLogs();
  await page.goto("https://example.com");
  await page.waitUntilReady();

  const snap = await page.snapshot();
  printSnapshot("example.com", snap.elements);
  const link = snap.elements.find((e) => e.tag === "a");
  if (link) {
    const result = await page.clickById(link.id);
    console.log(`\n🖱️  ${result.detail}`);
    console.log(`   effect verified → changed=${result.changed}, now at ${page.page.url()}`);
  }

  const links = await page.extractLinks();
  console.log(`\n📦 Extracted ${links.length} link(s).`);
  console.log(`🌐 Network responses captured: ${page.network().length}`);
}

async function demoReliability(page: AIPage) {
  console.log("\n=== Part 3: Reliability — graceful failure + heal hint ===");
  // Act on an element that doesn't exist: the layer retries, then fails cleanly
  // with an AI-actionable hint instead of hanging or throwing.
  const result = await page.clickById("e999");
  console.log(`\n🖱️  ok=${result.ok}  attempts=${result.attempts}`);
  console.log(`   ${result.detail}`);
}

async function demoSpeed(page: AIPage) {
  console.log("\n=== Part 4: Speed — caching + diff-based perception ===");
  await page.goto(FIXTURE);
  await page.waitUntilReady();

  await page.snapshot({ cache: true }); // baseline
  const a = await page.snapshot({ cache: true });
  const b = await page.snapshot({ cache: true });
  console.log(`🗄️  cache: unchanged page → second snapshot reused = ${a === b}`);

  // Mutate the DOM, then ask ONLY for the delta instead of the whole page.
  await page.evaluate(
    "document.body.insertAdjacentHTML('beforeend', '<button>Newly Added</button>')",
  );
  const diff = await page.changes();
  console.log(
    `📐 diff after adding one button → added=${diff.added.length} removed=${diff.removed.length} changed=${diff.changed.length} unchanged=${diff.unchanged}`,
  );
  for (const e of diff.added) console.log(`   + <${e.tag}> "${e.name}"`);
}

async function demoHeal(page: AIPage) {
  console.log("\n=== Part 5: True self-healing (element replaced, id moved) ===");
  await page.goto(FIXTURE);
  await page.waitUntilReady();
  const snap = await page.snapshot();
  const button = snap.elements.find((e) => e.tag === "button");
  if (!button) return;
  console.log(`Snapshot gave the Search button id "${button.id}".`);

  // Replace the button with a fresh, equivalent node → its old id disappears.
  await page.evaluate(
    "(() => { const b = document.getElementById('go'); const n = document.createElement('button'); n.textContent = 'Search'; n.setAttribute('onclick', \"console.log('healed click ran')\"); b.replaceWith(n); })()",
  );
  console.log(`Replaced the button node — id "${button.id}" no longer exists.`);

  const result = await page.clickById(button.id);
  console.log(`\n🩹 ${result.detail}`);
  const healed = page.console().some((e) => e.text.includes("healed click ran"));
  console.log(`   healed click actually executed on the new node: ${healed}`);
}

async function main() {
  // Headed by default so you can watch; set AI_BROWSER_HEADED=0 for automated/headless runs.
  const headed = process.env.AI_BROWSER_HEADED !== "0";
  const browser = await AIBrowser.launch({ headless: !headed });
  const page = await browser.newPage();

  await demoInteractAndCheck(page);
  await demoNavigateAndExtract(page);
  await demoReliability(page);
  await demoSpeed(page);
  await demoHeal(page);

  await page.page.waitForTimeout(1000);
  await browser.close();
  console.log("\n✅ Demo complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
