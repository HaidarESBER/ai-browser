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
import { AIBrowser, AIPage, type Snapshot, type SnapshotDiff } from "./browser.js";
import { LiveView } from "./live.js";

let browser: AIBrowser | null = null;
let page: AIPage | null = null;
let live: LiveView | null = null;

const TOOL_TIMEOUT_MS = 45_000;

/**
 * Serialize all tool handlers onto one queue. The server holds a single shared
 * page, so concurrent tool calls (which some clients issue) would otherwise race
 * on navigation / the id counter / the snapshot cache.
 */
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Bound a handler so one hung page (e.g. a URL that never reaches networkidle)
 * can't freeze the whole serial queue forever (S2). On timeout the queue is
 * freed; the underlying Playwright op may still finish in the background.
 */
function withTimeout<T>(fn: () => Promise<T>, ms = TOOL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool timed out after ${ms}ms`)), ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Every tool runs through this: serialized + time-bounded. */
function run<T>(fn: () => Promise<T>): Promise<T> {
  return serial(() => withTimeout(fn));
}

/** Drop the current session so the next getPage() relaunches (S4 recovery). */
function resetState(): void {
  page = null;
  browser = null;
  void live?.stop().catch(() => undefined);
  live = null;
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
    browser = await AIBrowser.launch({ headless: !headed });
    page = await browser.newPage();

    // S4: if the page closes or the browser crashes/disconnects, drop the session
    // so the next tool call transparently relaunches instead of throwing forever.
    page.page.on("close", resetState);
    page.page.context().browser()?.on("disconnected", resetState);

    if (process.env.AI_BROWSER_LIVE !== "0") {
      live = new LiveView(page);
      try {
        const url = await live.start();
        console.error(`[ecobrowser] live view: ${url}`);
      } catch (err) {
        console.error(`[ecobrowser] live view unavailable: ${(err as Error).message}`);
        live = null; // S7: don't retain a LiveView that never bound
      }
    }
  }
  return page;
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
}): string {
  const value = e.value ? ` value="${e.value}"` : "";
  const state = e.state?.length ? ` [${e.state.join(",")}]` : "";
  return `[${e.id}] <${e.tag}> role=${e.role} name="${e.name}"${value}${state}`;
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

// ---- INTERACT -------------------------------------------------------------

server.tool(
  "browser_click",
  "Click an element by its snapshot id. Returns a fresh snapshot after the action.",
  { id: z.string().describe("Element id from a snapshot, e.g. 'e0'") },
  async ({ id }) =>
    run(async () => {
      const p = await getPage();
      const since = Date.now();
      const result = await p.clickById(id);
      if (!result.ok) return text(result.detail);
      return text(await actionResponse(p, result.detail, since));
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
      const result = await p.typeById(id, value);
      if (!result.ok) return text(result.detail);
      return text(await actionResponse(p, result.detail, since));
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
      page = null;
      browser = null;
      live = null;
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
