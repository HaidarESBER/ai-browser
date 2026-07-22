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

/** Serve fixture pages from a fake http origin (pages can't link to data: URLs). */
async function site(p: AIPage, pages: Record<string, string>): Promise<string> {
  await p.page.route("http://fixture.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = pages[path];
    return body === undefined
      ? route.fulfill({ status: 404, body: "not found" })
      : route.fulfill({ contentType: "text/html", body });
  });
  return "http://fixture.test";
}

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

console.log("\nself-healing:");

/** Replace every button with a fresh, unstamped copy — what a framework re-render does. */
const rerender = (p: AIPage) =>
  p.page.evaluate(() => {
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const fresh = b.cloneNode(true) as HTMLElement;
      fresh.removeAttribute("data-ai-id");
      fresh.onclick = () => ((window as { clicked?: string }).clicked = fresh.dataset.item);
      b.replaceWith(fresh);
    }
  });

await check("heals a uniquely identifiable element after a re-render", async (p) => {
  await p.goto(html(`<button data-item=save>Save</button><button data-item=x>Close</button>`));
  const id = (await p.snapshot()).elements[0]!.id;
  await rerender(p);
  const r = await p.clickById(id);
  assert.equal(r.ok, true, r.detail);
  assert.equal(await p.page.evaluate(() => (window as { clicked?: string }).clicked), "save");
});

await check("refuses to guess between identical elements", async (p) => {
  await p.goto(html(`<p>A <button data-item=A>Delete</button></p><p>B <button data-item=B>Delete</button></p>`));
  const idB = (await p.snapshot()).elements[1]!.id;
  await rerender(p);
  const r = await p.clickById(idB);
  assert.equal(r.ok, false);
  assert.equal(await p.page.evaluate(() => (window as { clicked?: string }).clicked), undefined);
});

console.log("\nnon-idempotent actions:");

await check("a click that errors after dispatch is not repeated", async (p) => {
  // The handler counts the click, then blocks the page past Playwright's click timeout.
  const handler = `window.n=(window.n||0)+1;const t=Date.now();while(Date.now()-t<7000){}`;
  await p.goto(html(`<button onclick="${handler}">Place order</button>`));
  const s = await p.snapshot();
  const r = await p.clickById(s.elements[0]!.id);
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.maybeApplied, true);
  assert.equal(r.attempts, 1);
  assert.equal(await p.page.evaluate(() => (window as { n?: number }).n), 1);
});

await check("press / hover / scroll report an ActionResult", async (p) => {
  await p.goto(
    html(`<form onsubmit="event.preventDefault();window.n=(window.n||0)+1"><input aria-label=q></form>
      <button onmouseover="this.textContent='hovered'">Hover me</button>`),
  );
  const s = await p.snapshot();
  await p.typeById(s.elements[0]!.id, "x");
  const pr = await p.press("Enter");
  assert.equal(pr.ok, true, pr.detail);
  assert.equal(await p.page.evaluate(() => (window as { n?: number }).n), 1);
  const hv = await p.hoverById(s.elements[1]!.id);
  assert.equal(hv.ok, true, hv.detail);
  const sc = await p.scrollBy(200);
  assert.equal(sc.ok, true, sc.detail);
});

console.log("\nsettling:");

await check("an action on a never-idle page costs well under the old 8 s", async (p) => {
  await p.goto(html(`<button>Noop</button><script>setInterval(()=>fetch('data:,x'),200)</script>`));
  const s = await p.snapshot();
  const t = Date.now();
  const r = await p.clickById(s.elements[0]!.id);
  assert.equal(r.ok, true, r.detail);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

await check("a click that navigates still lands on the new page", async (p) => {
  const base = await site(p, {
    "/": `<a href="/next">Go</a>`,
    "/next": `<h1>Next</h1><button>Continue</button>`,
  });
  await p.goto(base + "/");
  const s = await p.snapshot();
  const r = await p.clickById(s.elements[0]!.id);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.changed, true);
  assert.equal((await p.snapshot()).elements[0]?.name, "Continue");
});

console.log("\nchange detection:");

await check("a checkbox toggle / menu open / relabel counts as a page change", async (p) => {
  await p.goto(
    html(`<input type=checkbox aria-label=Agree>
      <button aria-expanded=false onclick="this.setAttribute('aria-expanded','true')">Menu</button>
      <button onclick="this.textContent='Added'">Add</button>`),
  );
  const s = await p.snapshot();
  for (const e of s.elements) {
    const r = await p.clickById(e.id);
    assert.equal(r.changed, true, `${e.name}: ${r.detail}`);
  }
  const d = await p.changes();
  assert.equal(d.added.length + d.removed.length, 0);
  assert.equal(d.changed.length, 3);
});

console.log("\nperception coverage:");

await check("ARIA widgets, contenteditable and summary are visible", async (p) => {
  await p.goto(
    html(`<div role=checkbox aria-checked=false tabindex=0>Remember me</div>
      <div role=tab>Settings</div><div contenteditable=true aria-label=Comment></div>
      <details><summary>More</summary></details>`),
  );
  const names = (await p.snapshot()).elements.map((e) => `${e.role}:${e.name}`);
  for (const want of ["checkbox:Remember me", "tab:Settings", "div:Comment", "summary:More"]) {
    assert.ok(names.includes(want), `${want} missing from ${names.join(", ")}`);
  }
});

await check("elements inside open shadow DOM can be seen and clicked", async (p) => {
  await p.goto(
    html(`<x-btn></x-btn><script>
      customElements.define('x-btn', class extends HTMLElement { connectedCallback() {
        this.attachShadow({mode:'open'}).innerHTML = '<button onclick="window.top.hit=1">Shadow buy</button>';
      }});</script>`),
  );
  const e = (await p.snapshot()).elements.find((x) => x.name === "Shadow buy");
  assert.ok(e, "shadow button not in snapshot");
  const r = await p.clickById(e.id);
  assert.equal(r.ok, true, r.detail);
  assert.equal(await p.page.evaluate(() => (window as { hit?: number }).hit), 1);
});

await check("elements inside iframes can be seen, typed into and clicked", async (p) => {
  const base = await site(p, {
    "/": `<h1>Outer</h1><iframe src="/inner"></iframe>`,
    "/inner": `<input aria-label="Card number"><button onclick="parent.paid=1">Pay</button>`,
  });
  await p.goto(base + "/");
  await p.waitUntilReady();
  const s = await p.snapshot();
  const field = s.elements.find((e) => e.name === "Card number");
  const pay = s.elements.find((e) => e.name === "Pay");
  assert.ok(field && pay, JSON.stringify(s.elements));
  assert.equal((await p.typeById(field.id, "4242")).ok, true);
  assert.equal((await p.clickById(pay.id)).ok, true);
  assert.equal(await p.page.evaluate(() => (window as { paid?: number }).paid), 1);
});

await check("dropdowns list their options and accept a label", async (p) => {
  await p.goto(
    html(`<label>Country <select><option value=fr>France</option><option value=de>Germany</option></select></label>`),
  );
  const sel = (await p.snapshot()).elements[0]!;
  assert.equal(sel.name, "Country");
  assert.deepEqual(sel.options, ["France (fr)", "Germany (de)"]);
  assert.equal((await p.selectById(sel.id, "Germany")).ok, true);
  assert.equal((await p.snapshot()).elements[0]!.value, "de");
});

await check("aria-labelledby names a control; covered elements are flagged", async (p) => {
  await p.goto(
    html(`<span id=l>Email address</span><input aria-labelledby=l>
      <button>Behind</button>
      <div style="position:fixed;inset:0;background:#0008">Cookie banner</div>`),
  );
  const s = await p.snapshot();
  assert.equal(s.elements[0]!.name, "Email address");
  assert.ok(s.elements.find((e) => e.name === "Behind")?.state?.includes("obscured"));
});

console.log("\nnavigation:");

await check("goto accepts a bare domain", async (p) => {
  await p.page.route("https://fixture.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<a href=/>ok</a>" }));
  await p.goto("fixture.test/start");
  assert.equal(p.page.url(), "https://fixture.test/start");
});

await check("AI_BROWSER_BLOCK_PRIVATE blocks private hosts, including in-page requests", async () => {
  process.env.AI_BROWSER_BLOCK_PRIVATE = "1";
  const p = await browser.newPage();
  delete process.env.AI_BROWSER_BLOCK_PRIVATE;
  try {
    await assert.rejects(p.goto("http://169.254.169.254/latest/meta-data"), /private-network/);
    await p.page.route("https://fixture.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: "<h1>public</h1>" }),
    );
    await p.goto("https://fixture.test/");
    const leaked = await p.page.evaluate(() =>
      fetch("http://127.0.0.1:9/").then(
        () => "reached",
        (e: Error) => e.message,
      ),
    );
    assert.notEqual(leaked, "reached");
    assert.ok(p.network().every((n) => !n.url.includes("127.0.0.1")));
  } finally {
    await p.page.close();
  }
});

await browser.close();
console.log(`\n✅ ${passed} regression tests passed.`);
