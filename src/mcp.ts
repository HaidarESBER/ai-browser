#!/usr/bin/env node
/**
 * AI-Native Browser Framework — MCP server (M3)
 *
 * Exposes the core engine (src/browser.ts) as Model Context Protocol tools, so
 * any MCP client (Claude Desktop, Claude Code, Cursor, a custom agent) can drive
 * a real browser with zero code. This is the primary "AI plugs in here" surface.
 *
 * NOTE: stdout is the JSON-RPC channel — never console.log to it. Use console.error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { AIBrowser, AIPage, type ActionResult, type Snapshot, type SnapshotDiff } from "./browser.js";
import { LiveView } from "./live.js";

// Colour helpers — on for a terminal, off when piped or NO_COLOR is set.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const cyan = (s: string) => paint("36", s);
const green = (s: string) => paint("32", s);
const yellow = (s: string) => paint("33", s);
const magenta = (s: string) => paint("35", s);

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return (pkg.version as string) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  const head = (t: string) => bold(cyan(t));
  const row = (a: string, b: string) => `    ${green(a.padEnd(28))}${dim(b)}`;
  console.log(
    [
      "",
      `  ${bold(magenta("ecobrowser-mcp"))}  ${dim("v" + readVersion())}`,
      `  ${dim("An AI-native browser as an MCP server — structured perception, verified")}`,
      `  ${dim("self-healing actions, incremental diff perception, and a live view.")}`,
      "",
      `  ${head("USAGE")}`,
      row("ecobrowser-mcp", "start the MCP server on stdio"),
      row("ecobrowser-mcp --help", "show this help"),
      row("ecobrowser-mcp --version", "print the version"),
      "",
      `  ${head("QUICK SETUP")}`,
      `    ${yellow("Claude Desktop")}  ${dim("→ claude_desktop_config.json:")}`,
      `      ${dim('"ecobrowser": { "command": "npx", "args": ["ecobrowser-mcp"] }')}`,
      `    ${yellow("Claude Code")}     ${green("claude mcp add ecobrowser -- npx ecobrowser-mcp")}`,
      "",
      `  ${head("TOOLS")} ${dim("(22, all prefixed browser_)")}`,
      `    ${dim("navigate  back  forward  snapshot  changes  find  read_text  screenshot")}`,
      `    ${dim("click  type  select  press  hover  scroll  wait  tabs  switch_tab")}`,
      `    ${dim("console  network  evaluate  extract_links  reset")}`,
      "",
      `  ${head("ENVIRONMENT")}`,
      row("AI_BROWSER_HEADED=1", "show the browser window (default: headless)"),
      row("AI_BROWSER_PROFILE=dir", "keep cookies / logins in dir across sessions"),
      row("AI_BROWSER_LIVE=0", "disable the live-view server"),
      row("AI_BROWSER_LIVE_PORT=N", "preferred live-view port (default 7333)"),
      row("AI_BROWSER_ALLOW_LOCAL=1", "allow file:// / privileged navigation"),
      row("AI_BROWSER_BLOCK_PRIVATE=1", "block localhost / private-network hosts"),
      "",
      `  ${head("DOCS")}   ${cyan("https://github.com/HaidarESBER/ai-browser")}`,
      "",
    ].join("\n"),
  );
}

/** A boxed welcome shown when a human runs the bin directly in a terminal. */
function printWelcome(): void {
  const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const W = 50; // inner content width
  const line = (content: string) =>
    `  ${dim("│")}  ${content}${" ".repeat(Math.max(0, W - visLen(content)))}  ${dim("│")}`;
  const bar = (l: string, r: string) => `  ${dim(l + "─".repeat(W + 4) + r)}`;
  const item = (name: string, value: string) => `${yellow(name.padEnd(15))} ${value}`;
  console.error(
    [
      "",
      bar("┌", "┐"),
      line(`${bold(magenta("ecobrowser"))}  ${dim("v" + readVersion())}`),
      line(dim("An AI-native browser · MCP server")),
      line(""),
      line(item("Setup & tools", green("ecobrowser-mcp --help"))),
      line(item("Docs", cyan("github.com/HaidarESBER/ai-browser"))),
      bar("└", "┘"),
      `  ${dim("Waiting for MCP messages on stdin…  (Ctrl+C to quit)")}`,
      "",
    ].join("\n"),
  );
}

// CLI flags — handled before the stdio transport takes over the streams.
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (cliArgs.includes("--version") || cliArgs.includes("-v") || cliArgs.includes("-V")) {
  console.log(readVersion());
  process.exit(0);
}

// A human ran it directly in a terminal (MCP clients pipe stdin, so isTTY is false):
// show a welcome banner instead of a silent server that looks hung.
if (process.stdin.isTTY) {
  printWelcome();
}

let browser: AIBrowser | null = null;
let page: AIPage | null = null;
let live: LiveView | null = null;
// Every open tab, in the order they were opened; `page` is the one being driven.
let tabs: AIPage[] = [];

const TOOL_TIMEOUT_MS = Number(process.env.AI_BROWSER_TOOL_TIMEOUT_MS) || 45_000;
/** How long a timed-out tool gets to stop at a checkpoint before the session is reset. */
const CANCEL_GRACE_MS = 15_000;

/** Resolve with the promise's outcome, or { timedOut } after ms — never rejects. */
function settleWithin<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ timedOut: true } | { timedOut: false; ok: true; value: T } | { timedOut: false; ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, ok: true, value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ timedOut: false, ok: false, error });
      },
    );
  });
}

/**
 * Every tool runs through this: serialized + time-bounded. The server holds one
 * shared page, so concurrent tool calls (which some clients issue) would race on
 * navigation / the id counter / the snapshot cache; they queue instead.
 *
 * On timeout (S2) the work is NOT simply abandoned — an abandoned click keeps
 * retrying and could land during the next tool call. The page is told to cancel,
 * and the queue stays held until the work actually stops; if it hasn't within a
 * grace period, the browser session is reset so nothing can act behind the AI's back.
 */
let lock: Promise<unknown> = Promise.resolve();
function run<T>(fn: () => Promise<T>): Promise<T> {
  const job = lock.then(async () => {
    const work = fn();
    const outcome = await settleWithin(work, TOOL_TIMEOUT_MS);
    if (!outcome.timedOut) {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }
    page?.cancel();
    const stopped = await settleWithin(work, CANCEL_GRACE_MS);
    if (stopped.timedOut) await hardReset();
    throw new Error(
      `tool timed out after ${TOOL_TIMEOUT_MS}ms; ${
        stopped.timedOut ? "the browser session was reset" : "the action was cancelled"
      }. Take a fresh snapshot before continuing.`,
    );
  });
  lock = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

/**
 * Drop the current session so the next getPage() relaunches (S4 recovery).
 * Closes the browser too: forgetting it would leave a Chromium process behind.
 */
function resetState(): void {
  const old = browser;
  page = null;
  tabs = [];
  browser = null;
  void live?.stop().catch(() => undefined);
  live = null;
  void old?.close().catch(() => undefined);
}

/** resetState(), but waits for the browser to actually close. */
async function hardReset(): Promise<void> {
  const old = browser;
  resetState();
  await old?.close().catch(() => undefined);
}

/**
 * Lazily launch the browser on first use so the server starts instantly.
 * Headless by default (robust when launched as a child of an MCP client);
 * set AI_BROWSER_HEADED=1 to watch the native window. A browser-based live view
 * also starts (unless AI_BROWSER_LIVE=0) so a human can watch even when headless.
 */
async function getPage(): Promise<AIPage> {
  if (!page) {
    const headed = process.env.AI_BROWSER_HEADED === "1";
    const profile = process.env.AI_BROWSER_PROFILE;
    browser = profile
      ? await AIBrowser.launchPersistent(profile, { headless: !headed })
      : await AIBrowser.launch({ headless: !headed });
    const first = await browser.newPage();
    // S4: if the browser crashes/disconnects, drop the session so the next tool
    // call transparently relaunches instead of throwing forever.
    browser.onDisconnect(resetState);
    adoptTab(first);

    if (process.env.AI_BROWSER_LIVE !== "0") {
      live = new LiveView(first);
      try {
        const url = await live.start();
        console.error(`[ecobrowser] live view: ${url}`);
      } catch (err) {
        console.error(`[ecobrowser] live view unavailable: ${(err as Error).message}`);
        live = null; // S7: don't retain a LiveView that never bound
      }
    }
  }
  return page!;
}

/** Start driving a tab; when it closes, fall back to the previous one (or a fresh session). */
function adoptTab(tab: AIPage): void {
  tabs.push(tab);
  page = tab;
  live?.setPage(tab);
  tab.page.on("close", () => {
    tabs = tabs.filter((t) => t !== tab);
    if (page !== tab) return;
    page = tabs[tabs.length - 1] ?? null;
    if (page) live?.setPage(page);
    else resetState();
  });
}

/**
 * After an action: if it opened new tabs, switch to the newest so the AI keeps
 * following what it clicked, and say so. Returns the text to prepend, or "".
 */
async function followNewTabs(p: AIPage): Promise<string> {
  const opened = p.takeNewTabs();
  if (!opened.length) return "";
  for (const t of opened) adoptTab(new AIPage(t));
  const current = await getPage();
  await current.waitUntilReady();
  return `Switched to the new tab (${tabs.length} open; browser_tabs lists them).\n${formatSnapshot(await current.snapshot())}`;
}

/** Wrap a string as an MCP text result. */
function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Render one element line, including value + state flags. */
function formatElement(e: {
  id: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
  state?: string[];
  options?: string[];
}): string {
  const value = e.value ? ` value="${e.value}"` : "";
  const state = e.state?.length ? ` [${e.state.join(",")}]` : "";
  const options = e.options?.length ? ` options: ${e.options.join(" | ")}` : "";
  return `[${e.id}] <${e.tag}> role=${e.role} name="${e.name}"${value}${state}${options}`;
}

/** Render a snapshot as compact, model-friendly text. */
function formatSnapshot(snap: Snapshot): string {
  const lines = snap.elements.map(formatElement);
  return `URL: ${snap.url}\nTitle: ${snap.title}\nInteractive elements:\n${lines.join("\n") || "(none)"}`;
}

/**
 * Response body after an action: diff-by-default (cheap delta) plus any console
 * errors the action triggered, upgrading to a full snapshot only on wholesale change.
 */
async function actionResponse(p: AIPage, detail: string, since: number): Promise<string> {
  const diff = await p.changes();
  const churn = diff.added.length + diff.removed.length + diff.changed.length;
  const errs = p.errorsSince(since);
  const errText = errs.length
    ? `\n\n⚠ console during action:\n${errs.map((e) => `[${e.type}] ${e.text}`).join("\n")}`
    : "";
  if (churn > 30) {
    return `${detail}${errText}\n\nPage changed substantially — full snapshot:\n${formatSnapshot(await p.snapshot({ cache: true }))}`;
  }
  return `${detail}${errText}\n\nChanges since your last snapshot:\n${formatDiff(diff)}`;
}

/** The reply to an interaction: its failure, the tab it opened, or what changed. */
async function afterAction(p: AIPage, result: ActionResult, since: number) {
  if (!result.ok) return text(result.detail);
  const switched = await followNewTabs(p);
  if (switched) return text(`${result.detail}\n\n${switched}`);
  return text(await actionResponse(p, result.detail, since));
}

/** Render only the delta since the last snapshot — the incremental-perception payload. */
function formatDiff(d: SnapshotDiff): string {
  const lines: string[] = [];
  if (d.added.length) {
    lines.push(`+ added (${d.added.length}):`);
    for (const e of d.added) lines.push(`   [${e.id}] <${e.tag}> "${e.name}"`);
  }
  if (d.removed.length) {
    lines.push(`- removed (${d.removed.length}):`);
    for (const e of d.removed) lines.push(`   <${e.tag}> "${e.name}"`);
  }
  if (d.changed.length) {
    lines.push(`~ changed (${d.changed.length}):`);
    for (const c of d.changed) lines.push(`   [${c.id}] "${c.name}": ${c.from ?? "∅"} -> ${c.to ?? "∅"}`);
  }
  lines.push(`(${d.unchanged} unchanged)`);
  return lines.join("\n");
}

const server = new McpServer({ name: "ecobrowser", version: "0.1.1" });

// ---- SEE / NAVIGATE -------------------------------------------------------

server.tool(
  "browser_navigate",
  "Open a URL and return a structured snapshot of the page's interactive elements.",
  { url: z.string().describe("The URL to open") },
  async ({ url }) =>
    run(async () => {
      const p = await getPage();
      try {
        await p.goto(url);
      } catch (err) {
        return text(`Navigation failed: ${(err as Error).message}`);
      }
      await p.waitUntilReady();
      return text(formatSnapshot(await p.snapshot()));
    }),
);

server.tool(
  "browser_snapshot",
  "Get a structured snapshot of the current page — each interactive element has a stable id you can act on. Cached until the page changes.",
  {},
  async () => run(async () => text(formatSnapshot(await (await getPage()).snapshot({ cache: true })))),
);

server.tool(
  "browser_changes",
  "Return ONLY what changed since your last snapshot (added/removed/changed elements). Cheaper than a full snapshot — prefer this after an action.",
  {},
  async () => run(async () => text(formatDiff(await (await getPage()).changes()))),
);

server.tool(
  "browser_find",
  "Find interactive elements matching a description (e.g. 'search box', 'Sign in button') and get just the matches with their ids — far cheaper than reading a full snapshot when you know what you want.",
  { query: z.string().describe("What to look for, e.g. 'login button'") },
  async ({ query }) =>
    run(async () => {
      const matches = await (await getPage()).find(query);
      if (!matches.length) {
        return text(`No elements match "${query}". Take a snapshot to see what's available.`);
      }
      return text(matches.map(formatElement).join("\n"));
    }),
);

server.tool(
  "browser_read_text",
  "Return the visible text content of the current page (truncated).",
  {},
  async () => run(async () => text((await (await getPage()).readText()).slice(0, 5000))),
);

server.tool("browser_back", "Go back in the browser history.", {}, async () =>
  run(async () => {
    const p = await getPage();
    await p.back();
    await p.waitUntilReady();
    return text(`Now at ${p.page.url()}`);
  }),
);

server.tool("browser_forward", "Go forward in the browser history.", {}, async () =>
  run(async () => {
    const p = await getPage();
    await p.forward();
    await p.waitUntilReady();
    return text(`Now at ${p.page.url()}`);
  }),
);

server.tool(
  "browser_screenshot",
  "Take a screenshot of the visible page. Use only when the structured snapshot isn't enough (layout, images, canvas).",
  {},
  async () =>
    run(async () => {
      const shot = await (await getPage()).page.screenshot({ type: "jpeg", quality: 70 });
      return { content: [{ type: "image" as const, data: shot.toString("base64"), mimeType: "image/jpeg" }] };
    }),
);

server.tool(
  "browser_wait",
  "Wait for text to appear on the page (up to 20 s), or for a number of milliseconds (up to 10 s). Returns what changed.",
  {
    text: z.string().optional().describe("Text to wait for"),
    ms: z.number().int().min(0).max(10_000).optional().describe("Milliseconds to wait, if no text is given"),
  },
  async ({ text: wanted, ms }) =>
    run(async () => {
      const p = await getPage();
      if (wanted) {
        try {
          await p.page.getByText(wanted).first().waitFor({ state: "visible", timeout: 20_000 });
        } catch {
          return text(`"${wanted}" did not appear within 20 s.\n\n${formatDiff(await p.changes())}`);
        }
      } else {
        await new Promise((r) => setTimeout(r, ms ?? 1000));
      }
      return text(`${wanted ? `"${wanted}" appeared.` : "Waited."}\n\n${formatDiff(await p.changes())}`);
    }),
);

// ---- INTERACT -------------------------------------------------------------

server.tool(
  "browser_click",
  "Click an element by its snapshot id. Returns a fresh snapshot after the action.",
  { id: z.string().describe("Element id from a snapshot, e.g. 'e0'") },
  async ({ id }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      return afterAction(p, await p.clickById(id), since);
    }),
);

server.tool(
  "browser_type",
  "Type text into a field by its snapshot id (clears the field first).",
  {
    id: z.string().describe("Element id from a snapshot"),
    text: z.string().describe("Text to type"),
  },
  async ({ id, text: value }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      return afterAction(p, await p.typeById(id, value), since);
    }),
);

server.tool(
  "browser_select",
  "Choose an option in a dropdown (<select>) by its snapshot id. Pass the option's value or its visible label (the snapshot lists them).",
  {
    id: z.string().describe("Element id of the <select>"),
    value: z.string().describe("Option value or visible label"),
  },
  async ({ id, value }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      return afterAction(p, await p.selectById(id, value), since);
    }),
);

server.tool(
  "browser_press",
  "Press a key or chord on the focused element, e.g. 'Enter' to submit, 'Escape' to close a dialog, 'Tab', 'ArrowDown', 'Control+A'.",
  { key: z.string().describe("Key name, Playwright syntax") },
  async ({ key }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      return afterAction(p, await p.press(key), since);
    }),
);

server.tool(
  "browser_hover",
  "Hover over an element by its snapshot id (reveals menus and tooltips).",
  { id: z.string().describe("Element id from a snapshot") },
  async ({ id }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      return afterAction(p, await p.hoverById(id), since);
    }),
);

server.tool(
  "browser_scroll",
  "Scroll the page (loads lazy / infinite-scroll content). Returns what appeared.",
  {
    direction: z.enum(["down", "up"]).describe("Which way to scroll"),
    pixels: z.number().int().min(1).max(10_000).optional().describe("How far (default 800)"),
  },
  async ({ direction, pixels }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      const dy = (pixels ?? 800) * (direction === "up" ? -1 : 1);
      return afterAction(p, await p.scrollBy(dy), since);
    }),
);

server.tool(
  "browser_tabs",
  "List the open tabs (the current one is marked). Links with target=_blank open a new tab and the browser switches to it automatically.",
  {},
  async () =>
    run(async () => {
      await getPage();
      const lines = await Promise.all(
        tabs.map(async (t, i) => `${t === page ? "*" : " "} [${i}] ${await t.page.title().catch(() => "")} — ${t.page.url()}`),
      );
      return text(lines.join("\n"));
    }),
);

server.tool(
  "browser_switch_tab",
  "Switch to an open tab by its index from browser_tabs, and return its snapshot.",
  { index: z.number().int().min(0).describe("Tab index from browser_tabs") },
  async ({ index }) =>
    run(async () => {
      await getPage();
      const tab = tabs[index];
      if (!tab) return text(`No tab ${index}; ${tabs.length} open.`);
      page = tab;
      live?.setPage(tab);
      await tab.page.bringToFront();
      return text(formatSnapshot(await tab.snapshot()));
    }),
);

// ---- CHECK (debug) --------------------------------------------------------

server.tool(
  "browser_console",
  "Return console logs and page errors captured on the current page.",
  {},
  async () =>
    run(async () => {
      const entries = (await getPage()).console();
      return text(entries.map((e) => `[${e.type}] ${e.text}`).join("\n") || "(no console output)");
    }),
);

server.tool(
  "browser_network",
  "Return the network responses (status, method, url) captured on the current page.",
  {},
  async () =>
    run(async () => {
      const entries = (await getPage()).network();
      return text(entries.map((e) => `${e.status} ${e.method} ${e.url}`).join("\n") || "(no network activity)");
    }),
);

// ---- MANIPULATE / EXTRACT -------------------------------------------------

server.tool(
  "browser_evaluate",
  "Run a JavaScript EXPRESSION in the page and return its JSON-serialized result (e.g. `document.title` or `[...document.links].length`). Not a statement body.",
  { js: z.string().describe("A JS expression to evaluate in the page") },
  async ({ js }) =>
    run(async () => {
      try {
        const result = await (await getPage()).evaluate(js);
        let out: string;
        try {
          out = JSON.stringify(result);
        } catch {
          out = String(result); // circular / BigInt etc.
        }
        return text(out ?? "undefined");
      } catch (err) {
        return text(`evaluate error: ${(err as Error).message}`);
      }
    }),
);

server.tool(
  "browser_extract_links",
  "Extract all links on the page as name/href pairs.",
  {},
  async () =>
    run(async () => {
      const links = await (await getPage()).extractLinks();
      return text(links.map((l) => `- "${l.name}" -> ${l.href}`).join("\n") || "(no links)");
    }),
);

// ---- SESSION --------------------------------------------------------------

server.tool(
  "browser_reset",
  "Close and discard the current browser session; the next action starts a fresh one. Use to recover from a wedged or crashed page.",
  {},
  async () =>
    run(async () => {
      await hardReset();
      return text("Browser session reset. A fresh session will start on the next action.");
    }),
);

// ---- Lifecycle ------------------------------------------------------------

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await live?.stop();
  } catch {
    /* ignore */
  }
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
// S8: never leave a browser orphaned on an unexpected fault — clean up and exit.
process.on("uncaughtException", (err) => {
  console.error(`[ecobrowser] uncaught exception: ${err.stack ?? err}`);
  void shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[ecobrowser] unhandled rejection: ${String(reason)}`);
  void shutdown(1);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[ecobrowser] MCP server ready on stdio.");
