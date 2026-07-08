# AI-Native Browser Framework — Technical Specification

> **One-liner:** A downloadable TypeScript framework that gives an AI agent fast, complete control of a real browser — the perception and action layer that is an AI's hands and eyes on the web. Shipped as an **npm library** and an **MCP server**. Humans observe and supervise; the AI drives.

**Status:** Draft v2 (AI-first pivot) · **Owner:** _(maintainer)_ · **Language:** TypeScript · **Distribution:** npm + MCP

---

## 1. What this is

Not a browser with an AI feature — **the layer that makes a browser usable by an AI at all.** The primary "user" is a model, not a person. The framework exposes a browser's full capability surface through an interface designed to be consumed by an LLM: compact structured perception, a complete action set, console/network visibility, and speed.

The closest reference is a vendor AI-browser tool (e.g. Claude-in-Chrome's tool surface) — but **open, downloadable, faster, more complete, and not tied to one AI or one extension.**

### Primary goals
- **Fast** — the AI acts without a forced screenshot→vision round-trip on every step.
- **Free / complete** — nothing gated: navigate, interact, manipulate, extract, execute JS, read console + network, multi-tab, auth.
- **Pluggable** — any AI connects via MCP (zero code) or the npm API (in code).
- **Observable** — humans can watch a live view, pause, or take over. Supervision, not collaboration.

### Non-goals
- Not a consumer web browser / not a human-driven UI product.
- Not a hosted service (that can come later as an optional pro tier).
- Not a mass-scraping tool aimed at arbitrary third-party sites (see §8).

---

## 1.5 North Star & capability contract

**North star:** *An AI can see, check, navigate, interact with, and debug any website as freely and completely as a developer with DevTools open — and it actually works, with a pleasant experience for the person watching.*

Three pillars govern every design decision:

| Pillar | Meaning | Requirement |
|---|---|---|
| **Complete** — "do whatever it wants" | Never blocked by a missing capability | the capability contract below |
| **Correct** — "good results" | Actions succeed, not just fire | verification + smart waiting + recovery |
| **Pleasant** — for the human | The operator trusts and enjoys watching | live view + readable trace + clean control |

"Free to do anything" and "good results" are the same project: a tool that does anything *badly* is stuck in retry loops, not free.

### Capability contract — what "do whatever it wants" requires

The AI must be able to, at minimum:

- **See** — structured snapshot (a11y tree + labeled elements), on-demand screenshots, full text.
- **Check** — console logs, network requests/responses, page errors, DOM, computed styles.
- **Navigate** — go/back/forward/reload, links, redirects, multi-tab & popups.
- **Interact** — click, type, key press, scroll, hover, drag, select, file upload/download.
- **Manipulate** — execute arbitrary JS, modify DOM, set cookies/storage.
- **Extract** — clean text + schema-validated JSON, across pagination.
- **Authenticate** — save/reuse login state, credential + OTP/2FA hooks.
- **Debug** — the above console/network/error visibility as first-class, plus a replayable trace.

Every action is wrapped by the **Correct** layer: *did it work?* (post-action verification) → *is the page ready?* (smart waiting, not sleeps) → *if not, recover* (retry / re-perceive / heal).

---

## 2. Audience & distribution — one core, two entry points

```
        ┌───────────────────────────────┐
        │   CORE ENGINE (TypeScript)     │  perception + action over CDP
        └───────────────┬───────────────┘
          ┌─────────────┴─────────────┐
   ┌──────▼───────┐            ┌───────▼────────┐
   │  npm library │            │   MCP server   │
   │ import {...}  │            │ npx …-mcp      │
   └──────────────┘            └────────────────┘
```

| Audience | Entry point | Use |
|---|---|---|
| AI/agent engineers building in code | npm library | Embed the browser as a tool inside their agent |
| Web/automation & QA devs | npm library | Scripted automation, testing, debugging |
| Scrapers / data teams | npm library | Extraction ergonomics + BYO proxy/CAPTCHA |
| Anyone driving an MCP-native AI (Claude Desktop/Code, Cursor, custom) | MCP server | Point the client at the server → browser tools appear, no code |

One engine underneath keeps all four coherent instead of forking into separate products.

---

## 3. The moat: fast & free perception

Today's AI browsers loop `screenshot → vision model → decide → act`, paying a vision round-trip and heavy tokens every step. This framework's core differentiator:

**Structured-first perception.** The AI is given a compact representation of the page — the **accessibility tree / simplified DOM with labeled, addressable interactive elements** — so it can decide and act **without looking at pixels**. Screenshots become *optional*, requested only when visual reasoning is genuinely needed.

- **Fast** = structured perception (no forced vision hop) + CDP + multi-tab parallelism + response caching + deterministic element addressing.
- **Free** = complete action surface, nothing gated.
- **Token-efficient** = the page representation is pruned and stable, so the model spends context on reasoning, not raw HTML.

---

## 4. Capability surface (what the AI can do)

**Perception**
- `snapshot()` — compact structured page state (a11y tree + labeled interactive elements + text). The default the AI reasons over.
- `screenshot()` — pixels, on demand only.
- `console()` / `network()` — live DevTools console logs and network requests (a first-class feature, not an afterthought).
- `readText()` / `extract(schema)` — clean text or structured JSON extraction.

**Action**
- `navigate`, `click`, `type`, `press`, `scroll`, `hover`, `selectOption`, `upload`, `download`.
- `evaluate(js)` — run arbitrary JS in the page.
- Element addressing by stable id from the snapshot (not brittle CSS the model guessed).

**Session**
- Multi-tab / multi-page; cookies & storage; save/restore auth state; proxy config (BYO); CAPTCHA hook (BYO solver, §8).

---

## 5. API shape (the product IS the DX)

**npm library:**
```ts
import { AIBrowser } from "ecobrowser";

const browser = await AIBrowser.launch();          // local Chromium via CDP
const page = await browser.newPage();

await page.navigate("https://example.com");
const snap = await page.snapshot();                // compact, model-ready page state
await page.click(snap.elements.find(e => e.role === "button" && e.name === "Login").id);
const data = await page.extract({ products: [{ name: "string", price: "number" }] });

page.on("console", (log) => { /* stream / react to page errors */ });
```

**MCP server:** every method above is exposed as an MCP tool (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_extract`, `browser_console`, …). Launch with `npx ecobrowser-mcp`; any MCP client connects and the tools appear. Tool descriptions are written for a model to consume — token-lean, with clear affordances.

---

## 6. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  ENTRY POINTS                                              │
│  npm import  ·  MCP server (stdio/SSE)                     │
├──────────────────────────────────────────────────────────┤
│  CORE ENGINE (TypeScript)                                  │
│  • Perception: a11y/DOM → compact snapshot + element ids   │
│  • Action executor (stable-id addressing)                  │
│  • Console/network taps (CDP subscriptions)                │
│  • Session/tab/auth/proxy manager                          │
├──────────────────────────────────────────────────────────┤
│  DRIVER                                                    │
│  Playwright / CDP  →  local (or remote) Chromium           │
├──────────────────────────────────────────────────────────┤
│  OBSERVABILITY (optional)                                  │
│  Live view + pause/takeover control plane for a human      │
└──────────────────────────────────────────────────────────┘
```

- **Driver:** Playwright (TS-native) over the Chrome DevTools Protocol. CDP gives console (`Runtime.consoleAPICalled`), network, a11y tree, and DOM directly.
- **No browser farm required** — the developer runs Chromium locally. A remote/cloud driver is an optional later add-on, not core.
- **Human observability** is a side channel (live screencast + a "pause/resume/take-over" control), not part of the AI's action loop.

---

## 7. Roadmap & milestones

| # | Milestone | Deliverable | Status |
|---|---|---|---|
| M0 | **Spike** | Launch Chromium via Playwright; compact `snapshot()`; click by element id | ✅ done |
| M1 | **Core actions** | Full action set + `extractLinks()` + console/network taps | ✅ done |
| — | **Reliability layer** | Smart-wait + retry + effect verification + `ActionResult` + **self-healing** | ✅ done |
| M3 | **MCP server** | 13 MCP tools; `npx` launch; tested via a real MCP client | ✅ done |
| M4 | **Speed pass** | Caching + **diff-based perception**; benchmarked vs Playwright MCP | ✅ done |
| M5 | **Observability** | Loopback live view (screenshot + action trace) | ✅ done |
| — | **AI-friendliness** | `find()`, state flags, diff-by-default, action-scoped console, durable ids | ✅ done |
| — | **Hardening** | Loopback bind, XSS-safe trace, nav guard, log caps, timeouts, crash recovery, port fallback | ✅ done |
| M2 | **npm library** | Clean public entry point + build; package `ecobrowser` with `ecobrowser-mcp` bin | ✅ done |
| M6 | **Auth/proxy/CAPTCHA (BYO, scoped)** | Save auth state; proxy config; opt-in CAPTCHA hook | ⏳ next |

The open-source engine + MCP server (M0–M5 plus the reliability/AI-friendliness/hardening
passes) and the **npm package (M2)** are **built and tested** — one package, `ecobrowser`,
exposing the library via `import { AIBrowser } from "ecobrowser"` and the MCP server via the
`ecobrowser-mcp` bin. M6 is opt-in and user-owned (§8).

### Beyond the original roadmap (built)

- **Self-healing actions** — if an element's id moves (DOM re-rendered), the action re-locates it by identity (tag/role/name) and retries.
- **Durable ids** — an element keeps its id across snapshots, so the AI can reference something it saw several steps ago.
- **`browser_find`** — query interactive elements by description; get just the matches.
- **Element state flags** — `disabled/checked/selected/expanded/required/readonly/focused`.
- **Diff-by-default** — actions return the delta (auto-upgrading to a full snapshot on wholesale change), with any console errors the action triggered.

---

## 8. Legal & safety

Because it's a **downloadable framework the user runs themselves**, the operational/legal responsibility for *how it's used* sits with the end user — a much cleaner position than a hosted service. Still:

- **CAPTCHA/stealth** ships as an **opt-in, bring-your-own-key hook**, documented for authorized/own-site use. Not on by default; not a headline feature.
- **Respect robots.txt / ToS by default**, with explicit per-domain opt-out the user chooses.
- **Secrets:** never log credentials; encrypt any saved auth-state helpers.
- **Docs set norms:** position for automation, testing, and agent tooling on sites the user is authorized to access — not mass third-party scraping.

---

## 9. Competitive landscape

- **Stagehand** (TS) — closest analog; `act/extract/observe` on Playwright. Differentiate on speed (structured-first, less vision), completeness, and MCP-native distribution.
- **browser-use** (Python) — popular agent-browser loop; you're TS + MCP-native.
- **Playwright/Puppeteer** — your foundation, not a competitor.
- **Vendor AI-browser tools** (Claude-in-Chrome, Operator) — closed and vendor-bound; you're open, downloadable, model-agnostic.

**Wedge:** fastest + most complete AI-facing browser layer, model-agnostic, installable in one command as either a library or an MCP server.

---

## 10. Open questions

- ~~Package boundary: one package with an MCP entry, or `core` + `mcp` as separate npm packages?~~ **Resolved (M2):** one package — `ecobrowser` — exporting the library, with the MCP server as its `ecobrowser-mcp` bin.
- Snapshot format: adopt an existing a11y-tree serialization or design a bespoke token-lean schema?
- Bundle a Chromium (like Playwright) or require the user's, to keep install light?
- Remote/cloud driver: worth a thin abstraction in the core now, or defer entirely?

---

## 11. Recommended first move

Build **M0**: a TypeScript spike that launches Chromium via Playwright, emits a compact `snapshot()` (a11y tree + labeled element ids), and clicks an element **by id** — proving the structured-perception thesis (act without pixels) in a small program before any packaging or MCP work.
