# Changelog

## 0.2.0 — 2026-07-24

Fixes from a full review of 0.1.5 — each one has a regression test (`npm run regress`, `npm run regress:mcp`).

**Safety**
- **Fixed: element ids were reused after a navigation.** Every page started again at `e0`, so an id taken from the previous page silently targeted a different element on the next. Ids are now unique for the life of an `AIPage`; cloned nodes get their own.
- **Fixed: password values leaked into snapshots**, diffs, error messages and the live-view trace. They now read `[redacted]`.
- **Fixed: self-healing could act on the wrong element** when several shared a name ("Delete"). It now refuses when the match is ambiguous or the page is a different document.
- **Fixed: a failed click could be repeated.** A click that errors after it may have been dispatched is reported as `maybeApplied` and never retried; `press()` and `scrollBy()` are never retried.
- **Fixed: the live view was readable by other local processes and, via DNS rebinding, by websites.** It now requires a per-session token and checks the Host header.
- **Fixed: a timed-out MCP tool kept running** and could act during the next call. Timeouts now cancel the action, and the session is reset if it won't stop.
- **Added: `AI_BROWSER_BLOCK_PRIVATE=1`** blocks loopback / private-network / metadata hosts, for every request the page makes.
- **Improved: MCP replies quote page-controlled strings** and declare page content untrusted.

**Perception**
- **Added: ARIA widgets, contenteditable, `<summary>`, `[tabindex]`, open shadow DOM and iframes** are now in the snapshot and actionable.
- **Added: dropdown options** in the snapshot; `selectById` accepts a visible label.
- **Added: `obscured` / `transparent` state flags**; names use `aria-labelledby` and no longer glue a select's options or contain newlines.
- **Fixed: "no visible page change" for checkbox toggles, opened menus and relabelled buttons** — change detection now hashes element states; the diff reports relabels as changes.

**Behaviour**
- **Fixed: every action waited up to 8 s** on pages that never go network-idle. Settling is capped at 1.5 s (3 s for `waitUntilReady()`).
- **Fixed: links that open a new tab were invisible.** Actions report `newTabs`; the MCP server switches to the new tab (`browser_tabs`, `browser_switch_tab`).
- **Fixed: `goto("example.com")` failed.** Scheme-less URLs get `https://` (`http://` for localhost).
- **Fixed: typing into masked fields (phone, card) reported failure.** A reformatted value with the same characters counts as typed.
- **Added: `AIBrowser.launchPersistent(dir)` / `AI_BROWSER_PROFILE`** to stay signed in across runs.
- **Changed: `hoverById()`, `press()` and `scrollBy()` return an `ActionResult`.**

**MCP server**
- **Added: `browser_select`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_forward`, `browser_screenshot`, `browser_wait`, `browser_tabs`, `browser_switch_tab`** (22 tools).
- **Improved: snapshots are capped at 250 elements; `browser_read_text` pages with `offset`** instead of silently truncating.
- **Fixed: the server reported version 0.1.1**; closing the last tab no longer leaves a Chromium process behind.

**Install**
- **Fixed: a failed Chromium download failed `npm install`.** The postinstall hook now warns instead, and honours `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`.

## 0.1.5 — 2026-07-09

- **Improved: `ecobrowser-mcp --help` is colourised and cleanly laid out** (aligned columns, sectioned; respects `NO_COLOR` and plain-pipes when not a TTY).
- **Added: a welcome banner when run interactively.** Running `ecobrowser-mcp` directly in a terminal now prints a boxed welcome (setup + docs) instead of looking like a hung process. (This is the reliable "welcome" — npm makes an install-time one impossible.)
- **Removed: the post-install banner.** npm hides dependency install-script output by default, so it almost never surfaced; the README (npm page) and `--help` are the real guides. Chromium still auto-installs via the postinstall hook.

## 0.1.4 — 2026-07-09

- **Added: `ecobrowser-mcp --help` and `--version`.** The MCP bin now prints setup, the tool list, and env vars (`--help`) or the version (`--version`) instead of only starting the stdio server.
- **Added: a post-install getting-started note.** After `npm install`, a short banner points to `npx ecobrowser-mcp --help` and the library import (skipped cleanly under `--ignore-scripts`).

## 0.1.3 — 2026-07-09

- **Added: Chromium installs automatically.** A `postinstall` hook runs `playwright install chromium`, so `npm install ecobrowser` fetches the browser with no manual step. (Installs with `--ignore-scripts` still need `npx playwright install chromium`.)

## 0.1.2 — 2026-07-09

Trace and reporting fixes surfaced while producing a supervised-session recording.

- **Fixed: the live-view trace missed navigations.** Only `goto()` was logged, so a navigation from an Enter-submit, form post, or link click left the page changing with nothing in the trace. Every main-frame navigation is now recorded — the supervisor view tracks the full session.
- **Fixed: actions that navigate reported "no visible page change."** Change detection now counts real navigations, so a click or submit that loads a new page is reliably reported as "page changed" even when the fingerprint is captured mid-transition.
- **Improved: richer action trace.** `read`, `find`, `extract`, `hover`, `scroll`, `press`, and `evaluate` are now recorded, so the trace reflects the AI's full activity, not just clicks/types/navigations.
- **Fixed: ANSI escape codes leaked into error details.** Playwright error messages (which embed terminal colour codes) are stripped before appearing in an `ActionResult` or the trace.
- **Improved: live view refreshes faster** (frames 300 ms, trace 500 ms) for a more real-time supervisor view.

## 0.1.1 — 2026-07-08

Fixes from the first round of real-site field testing (example.com, Hacker News, Wikipedia, httpbin forms).

- **Fixed: perception crashed when racing a navigation.** `snapshot()` / `changes()` / `readText()` / `extractLinks()` threw `Execution context was destroyed` when called while a navigation was in flight (the canonical *type → Enter → look* agent pattern). Perception now detects the destroyed context, waits for the new document, and retries internally. Unrelated errors still propagate.
- **Improved: `find()` understands element-kind words.** Words like *box, field, input, button, link, checkbox, dropdown* now match against the element's tag/role instead of its name — `find("search box")` finds the search input (previously zero results, since no element's name contains "box"), and ranks it above a button named "Search" (kind match boosts, kind mismatch demotes).
- **Fixed: label-wrapped inputs had no accessible name.** Inputs associated with a `<label>` (wrapping or `for=`) now take the label text as their name, so description-based targeting works on plain HTML forms.
- **Fixed: `network()` was empty right after `goto()`.** The per-page log reset on navigation was also wiping the navigation's own document request; it's now preserved.
- **Added: `goto(url, { timeoutMs, waitUntil })`.** Escape hatches for slow or never-settling pages (e.g. `waitUntil: "domcontentloaded"`, a shorter `timeoutMs`) instead of dying on Playwright's 30 s default.

## 0.1.0 — 2026-07-08

First npm release (`ecobrowser`, with the `ecobrowser-mcp` bin): the core engine (structured snapshots with durable ids, verified self-healing actions, incremental diff perception, console/network capture), the 13-tool MCP server, and the loopback live view.
