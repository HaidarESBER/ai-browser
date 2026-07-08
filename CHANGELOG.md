# Changelog

## 0.1.1 — 2026-07-08

Fixes from the first round of real-site field testing (example.com, Hacker News, Wikipedia, httpbin forms).

- **Fixed: perception crashed when racing a navigation.** `snapshot()` / `changes()` / `readText()` / `extractLinks()` threw `Execution context was destroyed` when called while a navigation was in flight (the canonical *type → Enter → look* agent pattern). Perception now detects the destroyed context, waits for the new document, and retries internally. Unrelated errors still propagate.
- **Improved: `find()` understands element-kind words.** Words like *box, field, input, button, link, checkbox, dropdown* now match against the element's tag/role instead of its name — `find("search box")` finds the search input (previously zero results, since no element's name contains "box"), and ranks it above a button named "Search" (kind match boosts, kind mismatch demotes).
- **Fixed: label-wrapped inputs had no accessible name.** Inputs associated with a `<label>` (wrapping or `for=`) now take the label text as their name, so description-based targeting works on plain HTML forms.
- **Fixed: `network()` was empty right after `goto()`.** The per-page log reset on navigation was also wiping the navigation's own document request; it's now preserved.
- **Added: `goto(url, { timeoutMs, waitUntil })`.** Escape hatches for slow or never-settling pages (e.g. `waitUntil: "domcontentloaded"`, a shorter `timeoutMs`) instead of dying on Playwright's 30 s default.

## 0.1.0 — 2026-07-08

First npm release (`ecobrowser`, with the `ecobrowser-mcp` bin): the core engine (structured snapshots with durable ids, verified self-healing actions, incremental diff perception, console/network capture), the 13-tool MCP server, and the loopback live view.
