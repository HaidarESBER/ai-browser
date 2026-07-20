/**
 * Browser-backed regression tests — one block per review finding, each driving
 * a real headless Chromium against a small inline fixture.
 * Run with: npm run regress
 */
import assert from "node:assert/strict";
import { AIBrowser, type AIPage } from "./browser.js";

const browser = await AIBrowser.launch({ headless: true });
let passed = 0;

async function check(name: string, fn: (p: AIPage) => Promise<void>) {
  const p = await browser.newPage();
  try {
    await fn(p);
    passed++;
    console.log(`  ✓ ${name}`);
  } finally {
    await p.page.close();
  }
}

const html = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

console.log("secrets:");

await check("password values never reach the snapshot", async (p) => {
  await p.goto(html(`<input type=password aria-label="Password"><input aria-label="User">`));
  let s = await p.snapshot();
  await p.typeById(s.elements[0]!.id, "hunter2");
  await p.typeById(s.elements[1]!.id, "alice");
  s = await p.snapshot();
  assert.equal(s.elements[0]!.value, "[redacted]");
  assert.equal(s.elements[1]!.value, "alice");
  assert.ok(!JSON.stringify(p.events()).includes("hunter2"));
});

console.log("\ntyping:");

await check("a field that reformats input still counts as typed", async (p) => {
  const mask = `this.value=this.value.replace(/\\D/g,'').replace(/(\\d{2})(?=\\d)/g,'$1 ')`;
  await p.goto(html(`<input aria-label="Phone" oninput="${mask}">`));
  const s = await p.snapshot();
  const r = await p.typeById(s.elements[0]!.id, "0612345678");
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.attempts, 1);
  assert.match(r.detail, /reformatted the input to "06 12 34 56 78"/);
});

console.log("\nelement ids:");

await check("ids are never reused after a navigation", async (p) => {
  await p.goto(html(`<button>Delete account</button><button>Cancel</button>`));
  const a = await p.snapshot();
  await p.goto(html(`<button>Buy now</button><button>Cancel</button>`));
  const b = await p.snapshot();
  const aIds = new Set(a.elements.map((e) => e.id));
  assert.ok(b.elements.every((e) => !aIds.has(e.id)), JSON.stringify([a, b]));
});

await check("a stale id from the previous page does not click the new page", async (p) => {
  await p.goto(html(`<button>Delete account</button>`));
  const stale = (await p.snapshot()).elements[0]!.id;
  await p.goto(html(`<button onclick="window.bought=1">Buy now</button>`));
  await p.snapshot();
  const r = await p.clickById(stale);
  assert.equal(r.ok, false);
  assert.equal(await p.page.evaluate(() => (window as { bought?: number }).bought), undefined);
});

await check("cloned nodes get their own ids", async (p) => {
  await p.goto(html(`<div id=l><button>Delete</button></div>`));
  await p.snapshot();
  await p.page.evaluate(() => {
    const l = document.getElementById("l")!;
    l.innerHTML += l.innerHTML; // copies data-ai-id along with the markup
  });
  const ids = (await p.snapshot()).elements.map((e) => e.id);
  assert.equal(new Set(ids).size, 2, ids.join(","));
});

await browser.close();
console.log(`\n✅ ${passed} regression tests passed.`);
