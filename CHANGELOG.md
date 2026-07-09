# Changelog

## 0.1.5 — 2026-07-09

- **Improved: `ecobrowser-mcp --help` is colourised and cleanly laid out** (aligned columns, sectioned; respects `NO_COLOR` and plain-pipes when not a TTY).
- **Added: a startup hint when run interactively.** Running `ecobrowser-mcp` directly in a terminal now prints a one-line note pointing to `--help`, instead of looking like a hung process.
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
