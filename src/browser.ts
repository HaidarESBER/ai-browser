/**
 * AI-Native Browser Framework — core engine (M1)
 *
 * Wraps Playwright with an AI-facing capability surface from the SPEC's
 * capability contract: See, Check, Navigate, Interact, Manipulate, Extract —
 * plus a small "Correct" helper (waitUntilReady) so actions land on a settled page.
 */
import {
  chromium,
  type Browser,
  type LaunchOptions,
  type Page,
} from "playwright";

/** A single addressable element the AI can act on, from the structured snapshot. */
export interface SnapshotElement {
  id: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  /** Active states the AI needs to act correctly: disabled, checked, expanded, … */
  state?: string[];
}

/** Compact, model-ready view of the page — enough to decide an action without pixels. */
export interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

/** A captured console log / page error — the "Check" (debug) surface. */
export interface ConsoleEntry {
  type: string;
  text: string;
  ts: number;
}

/** A captured network response — the "Check" (network) surface. */
export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  ts: number;
}

/** An extracted link, from the deterministic "Extract" surface. */
export interface Link {
  name: string;
  href: string;
}

/** Options controlling the reliability wrapper around an action. */
export interface ReliabilityOptions {
  retries?: number;
  backoffMs?: number;
  settleTimeoutMs?: number;
}

/** A lightweight page fingerprint used to detect whether an action changed anything. */
export interface PageFingerprint {
  url: string;
  title: string;
  elementCount: number;
}

/** Structured outcome of a reliable action — tells the AI exactly what happened. */
export interface ActionResult {
  ok: boolean;
  action: string;
  changed: boolean;
  attempts: number;
  detail: string;
  error?: string;
  before?: PageFingerprint;
  after?: PageFingerprint;
}

/** What changed between two snapshots — the incremental-perception payload. */
export interface SnapshotDiff {
  added: SnapshotElement[];
  removed: SnapshotElement[];
  changed: { id: string; name: string; from?: string; to?: string }[];
  unchanged: number;
}

/** A recorded action/navigation event — the trace behind the live view. */
export interface PageEvent {
  ts: number;
  kind: string;
  detail: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Cap on retained console/network entries per page, to bound memory (M1). */
const MAX_LOG = 500;

/** Schemes we refuse to navigate to by default (local-file / privileged). */
const BLOCKED_SCHEMES = new Set([
  "file:",
  "chrome:",
  "chrome-extension:",
  "view-source:",
  "javascript:",
]);

/**
 * True if navigating to this URL should be blocked (local-file / privileged
 * scheme) — a guard against an AI being steered into reading local files or
 * internal privileged pages. Pass allowLocal to opt out.
 */
export function isBlockedNavigation(url: string, allowLocal = false): boolean {
  if (allowLocal) return false;
  let protocol: string;
  try {
    protocol = new URL(url).protocol.toLowerCase();
  } catch {
    return false; // relative / scheme-less — Playwright resolves it to https
  }
  return BLOCKED_SCHEMES.has(protocol);
}

/**
 * Diff two snapshots. Elements are keyed by semantic signature (tag|role|name)
 * plus an occurrence index, so repeated identical elements (e.g. five identical
 * buttons) are matched positionally instead of collapsing to one key.
 */
export function computeSnapshotDiff(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const makeKeyer = () => {
    const seen = new Map<string, number>();
    return (e: SnapshotElement) => {
      const base = `${e.tag}|${e.role}|${e.name}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return `${base}#${n}`;
    };
  };

  const pk = makeKeyer();
  const prevEntries = prev.elements.map((e) => [pk(e), e] as const);
  const prevMap = new Map(prevEntries);

  const nk = makeKeyer();
  const nextEntries = next.elements.map((e) => [nk(e), e] as const);
  const nextKeys = new Set(nextEntries.map(([k]) => k));

  const added = nextEntries.filter(([k]) => !prevMap.has(k)).map(([, e]) => e);
  const removed = prevEntries.filter(([k]) => !nextKeys.has(k)).map(([, e]) => e);

  const desc = (x: SnapshotElement) => {
    const parts: string[] = [];
    if (x.value !== undefined) parts.push(`value="${x.value}"`);
    if (x.state?.length) parts.push(`[${x.state.join(",")}]`);
    return parts.join(" ") || "∅";
  };

  const changed: SnapshotDiff["changed"] = [];
  let unchanged = 0;
  for (const [k, e] of nextEntries) {
    const p = prevMap.get(k);
    if (!p) continue;
    // Changed if the value OR the state flags differ (e.g. a checkbox toggled).
    if (p.value !== e.value || (p.state ?? []).join(",") !== (e.state ?? []).join(",")) {
      changed.push({ id: e.id, name: e.name, from: desc(p), to: desc(e) });
    } else {
      unchanged++;
    }
  }
  return { added, removed, changed, unchanged };
}

/**
 * Score how well an element matches a natural-language query. Deterministic —
 * no LLM — so `find()` is cheap. Exact-name beats prefix beats substring beats
 * all-words-present.
 */
export function elementMatchScore(e: SnapshotElement, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const name = e.name.toLowerCase();
  const hay = `${name} ${e.role} ${e.tag}`.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 70;
  if (name.includes(q)) return 50;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => hay.includes(w))) return 30;
  if (hay.includes(q)) return 20;
  return 0;
}

/**
 * An AI-facing wrapper around one browser page. Every method maps to a row of
 * the capability contract, so an agent (or the coming MCP server) has one
 * coherent surface to work against.
 */
export class AIPage {
  private readonly consoleLog: ConsoleEntry[] = [];
  private readonly networkLog: NetworkEntry[] = [];
  private readonly eventLog: PageEvent[] = [];

  // Speed: remember the last snapshot + DOM version to serve cache hits and diffs.
  private lastSnapshot: Snapshot | null = null;
  private lastDomVersion = -1;

  constructor(public readonly page: Page) {
    // CHECK: tap console + page errors + network as they happen (first-class).
    page.on("console", (msg) =>
      this.pushCapped(this.consoleLog, { type: msg.type(), text: msg.text(), ts: Date.now() }),
    );
    page.on("pageerror", (err) =>
      this.pushCapped(this.consoleLog, { type: "error", text: err.message, ts: Date.now() }),
    );
    page.on("response", (res) =>
      this.pushCapped(this.networkLog, {
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        ts: Date.now(),
      }),
    );
    // Logs describe the CURRENT page: reset them when the main frame navigates.
    page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame()) this.clearLogs();
    });
  }

  private pushCapped<T>(log: T[], entry: T): void {
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
  }

  // ---- SEE ----------------------------------------------------------------

  /**
   * Build a structured snapshot of the page's interactive elements, tagging each
   * with a stable id (data-ai-id) so the AI can act on it deterministically —
   * no coordinates, no guessed CSS selectors, no screenshot round-trip.
   */
  async snapshot(opts: { cache?: boolean } = {}): Promise<Snapshot> {
    const version = await this.domVersion();
    if (
      opts.cache &&
      this.lastSnapshot &&
      version === this.lastDomVersion &&
      this.lastSnapshot.url === this.page.url()
    ) {
      return this.lastSnapshot; // cache hit: skip the full DOM walk + serialization
    }
    const snap = await this.buildSnapshot();
    this.lastSnapshot = snap;
    this.lastDomVersion = version;
    return snap;
  }

  /**
   * Incremental perception: return only what changed since the last snapshot,
   * instead of re-sending the whole page. Cheaper for the model in both latency
   * and tokens — the core speed differentiator.
   */
  async changes(): Promise<SnapshotDiff> {
    const prev = this.lastSnapshot;
    const next = await this.buildSnapshot();
    this.lastSnapshot = next;
    this.lastDomVersion = await this.domVersion();
    if (!prev) return { added: next.elements, removed: [], changed: [], unchanged: 0 };
    return computeSnapshotDiff(prev, next);
  }

  private async buildSnapshot(): Promise<Snapshot> {
    const elements = await this.page.evaluate(() => {
      const SELECTOR =
        'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]';
      const results: SnapshotElement[] = [];
      // Durable ids: a persistent per-page counter, and we REUSE any id already
      // stamped on an element — so a surviving element keeps the same id across
      // snapshots, and the AI can reference something it saw several steps ago.
      const w = window as unknown as { __aiIdCounter?: number };
      if (w.__aiIdCounter === undefined) w.__aiIdCounter = 0;

      for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (
          rect.width === 0 ||
          rect.height === 0 ||
          style.visibility === "hidden" ||
          style.display === "none"
        ) {
          continue;
        }

        let id = el.getAttribute("data-ai-id");
        if (!id) {
          id = `e${w.__aiIdCounter++}`;
          el.setAttribute("data-ai-id", id);
        }

        const name =
          (el as HTMLElement).innerText?.trim() ||
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          "";

        const entry: SnapshotElement = {
          id,
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          name: name.slice(0, 120),
          tag: el.tagName.toLowerCase(),
        };
        const value = (el as HTMLInputElement).value;
        if (value) entry.value = value.slice(0, 120);

        // State flags the AI needs to act correctly (don't click a disabled button, etc.).
        const inp = el as unknown as {
          disabled?: boolean;
          checked?: boolean;
          selected?: boolean;
          required?: boolean;
          readOnly?: boolean;
        };
        const s: string[] = [];
        if (inp.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
        if (
          (el.matches("input[type=checkbox], input[type=radio]") && inp.checked) ||
          el.getAttribute("aria-checked") === "true"
        )
          s.push("checked");
        if (
          (el.tagName === "OPTION" && inp.selected) ||
          el.getAttribute("aria-selected") === "true"
        )
          s.push("selected");
        if (el.getAttribute("aria-expanded") === "true") s.push("expanded");
        if (inp.required || el.getAttribute("aria-required") === "true") s.push("required");
        if (inp.readOnly || el.getAttribute("aria-readonly") === "true") s.push("readonly");
        if (el === document.activeElement) s.push("focused");
        if (s.length) entry.state = s;

        results.push(entry);
      }
      return results;
    });

    return { url: this.page.url(), title: await this.page.title(), elements };
  }

  /**
   * Cheap DOM-version read for cache invalidation. Installs (once per page) a
   * MutationObserver that counts real DOM changes — ignoring our own data-ai-id
   * tagging so building a snapshot never invalidates its own cache.
   */
  private async domVersion(): Promise<number> {
    return this.page.evaluate(() => {
      const w = window as unknown as { __aiDomVersion?: number };
      if (w.__aiDomVersion === undefined) {
        w.__aiDomVersion = 0;
        new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === "attributes" && r.attributeName === "data-ai-id") continue;
            w.__aiDomVersion = (w.__aiDomVersion ?? 0) + 1;
            break;
          }
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      }
      return w.__aiDomVersion;
    });
  }

  /** Pixels, on demand only — for when structure isn't enough. */
  async screenshot(path?: string): Promise<Buffer> {
    return this.page.screenshot(path ? { path } : undefined);
  }

  /** Full visible text of the page. */
  async readText(): Promise<string> {
    return this.page.evaluate(() => document.body.innerText);
  }

  /**
   * Find interactive elements matching a natural-language description, ranked —
   * so the AI can ask for "the search box" and get just the match(es) instead of
   * reading a whole-page snapshot. Deterministic (no LLM).
   */
  async find(query: string, limit = 5): Promise<SnapshotElement[]> {
    const snap = await this.snapshot({ cache: true });
    return snap.elements
      .map((e) => ({ e, score: elementMatchScore(e, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
  }

  // ---- CHECK --------------------------------------------------------------

  /** Console logs + page errors captured so far. */
  console(): ConsoleEntry[] {
    return [...this.consoleLog];
  }

  /** Network responses captured so far. */
  network(): NetworkEntry[] {
    return [...this.networkLog];
  }

  /** Console errors/warnings recorded at or after a timestamp — for action-scoped reporting. */
  errorsSince(ts: number): ConsoleEntry[] {
    return this.consoleLog.filter(
      (e) => e.ts >= ts && (e.type === "error" || e.type === "warning" || e.type === "warn"),
    );
  }

  /** Reset captured logs (e.g. before a new step). */
  clearLogs(): void {
    this.consoleLog.length = 0;
    this.networkLog.length = 0;
  }

  /** Recorded action/navigation events — the trace shown in the live view. */
  events(): PageEvent[] {
    return [...this.eventLog];
  }

  private record(kind: string, detail: string): void {
    this.eventLog.push({ ts: Date.now(), kind, detail });
    if (this.eventLog.length > 200) this.eventLog.shift();
  }

  // ---- NAVIGATE -----------------------------------------------------------

  async goto(url: string): Promise<void> {
    if (isBlockedNavigation(url, process.env.AI_BROWSER_ALLOW_LOCAL === "1")) {
      throw new Error(
        `navigation to "${url}" is blocked (local-file/privileged scheme). Set AI_BROWSER_ALLOW_LOCAL=1 to allow.`,
      );
    }
    await this.page.goto(url);
    this.record("navigate", url);
  }

  async back(): Promise<void> {
    await this.page.goBack();
    this.record("back", this.page.url());
  }

  async forward(): Promise<void> {
    await this.page.goForward();
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  /** CORRECT: wait until the page has settled (network idle) before acting. */
  async waitUntilReady(timeoutMs = 10_000): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: timeoutMs });
    } catch {
      // networkidle can never arrive on live-updating pages; fall back to DOM ready.
      await this.page.waitForLoadState("domcontentloaded");
    }
  }

  // ---- INTERACT (wrapped by the reliability layer) ------------------------

  /** Click an element by id — reliability + self-healing if the id has moved. */
  async clickById(id: string): Promise<ActionResult> {
    return this.reliableOnElement(id, "click", async (sel) => {
      // Short existence check (fast failure if the id is gone), then a more
      // generous actionability window (slow-rendering / throttled pages).
      await this.page.waitForSelector(sel, { state: "visible", timeout: 5000 });
      await this.page.click(sel, { timeout: 10000 });
    });
  }

  /** Type into a field by id, then verify the typed value actually landed. */
  async typeById(id: string, text: string): Promise<ActionResult> {
    return this.reliableOnElement(id, "type into", async (sel) => {
      await this.page.waitForSelector(sel, { state: "visible", timeout: 5000 });
      await this.page.fill(sel, text);
      const actual = await this.page.inputValue(sel);
      if (actual !== text) {
        throw new Error(`field holds "${actual}" after typing, expected "${text}"`);
      }
    });
  }

  /** Select an option by id, with reliability + self-healing. */
  async selectById(id: string, value: string): Promise<ActionResult> {
    return this.reliableOnElement(id, `select "${value}" in`, async (sel) => {
      await this.page.waitForSelector(sel, { state: "visible", timeout: 5000 });
      await this.page.selectOption(sel, value, { timeout: 10000 });
    });
  }

  async hoverById(id: string): Promise<void> {
    await this.page.hover(this.sel(id));
  }

  async scrollBy(dy: number): Promise<void> {
    await this.page.mouse.wheel(0, dy);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  // ---- MANIPULATE ---------------------------------------------------------

  /** Run arbitrary JS in the page. */
  async evaluate<T>(fn: string): Promise<T> {
    return this.page.evaluate(fn) as Promise<T>;
  }

  // ---- EXTRACT ------------------------------------------------------------

  /** Deterministic extraction of all links (LLM-schema extraction comes later). */
  async extractLinks(): Promise<Link[]> {
    return this.page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => ({
        name: (a as HTMLElement).innerText.trim().slice(0, 120),
        href: (a as HTMLAnchorElement).href,
      })),
    );
  }

  // ---- CORRECT (reliability layer) ----------------------------------------

  /**
   * Run an action with the "good results" guarantees: retry transient failures
   * with backoff, wait for the page to settle afterward, and report whether the
   * action actually changed anything — so the AI can tell success from silent no-op.
   * (Retries re-run the same action; it does not yet re-map ids from a fresh snapshot.)
   */
  private async reliable(
    action: string,
    fn: () => Promise<void>,
    opts: ReliabilityOptions = {},
  ): Promise<ActionResult> {
    const retries = opts.retries ?? 2;
    const backoffMs = opts.backoffMs ?? 300;
    const before = await this.fingerprint();

    let lastError: unknown;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        await fn();
        await this.waitUntilReady(opts.settleTimeoutMs ?? 8000);
        const after = await this.fingerprint();
        const changed =
          before.url !== after.url ||
          before.title !== after.title ||
          before.elementCount !== after.elementCount;
        const detail = `${action} succeeded${changed ? " (page changed)" : " (no visible page change)"}.`;
        this.record("action", detail);
        return { ok: true, action, changed, attempts: attempt, before, after, detail };
      } catch (err) {
        lastError = err;
        if (attempt <= retries) await sleep(backoffMs * attempt);
      }
    }

    const after = await this.fingerprint().catch(() => before);
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const hint = /selector|timeout/i.test(message)
      ? " The element may no longer exist — take a fresh snapshot and retry."
      : "";
    const detail = `${action} failed after ${retries + 1} attempt(s): ${message}.${hint}`;
    this.record("error", detail);
    return { ok: false, action, changed: false, attempts: retries + 1, before, after, error: message, detail };
  }

  /**
   * Run an id-targeted action with reliability AND self-healing: if the id can no
   * longer be located (the element was replaced by an equivalent new node),
   * re-snapshot, find the same element by its identity (tag/role/name), and retry
   * on the new id — so a re-rendered page doesn't strand the AI.
   */
  private async reliableOnElement(
    id: string,
    verb: string,
    act: (selector: string) => Promise<void>,
  ): Promise<ActionResult> {
    const first = await this.reliable(`${verb} ${id}`, () => act(this.sel(id)), { retries: 1 });
    if (first.ok) return first;

    const newId = await this.healId(id);
    if (!newId) return first;

    return this.reliable(`${verb} ${id} (re-located as ${newId})`, () => act(this.sel(newId)));
  }

  /**
   * Self-heal: if the original id has vanished from the page, find a replacement
   * element with the same identity (tag/role/name) and return its new id. Returns
   * null if the id still exists (a real failure, not a moved id) or nothing matches.
   */
  private async healId(id: string): Promise<string | null> {
    const prev = this.lastSnapshot?.elements.find((e) => e.id === id);
    if (!prev) return null;
    const fresh = await this.buildSnapshot();
    this.lastSnapshot = fresh;
    this.lastDomVersion = await this.domVersion();
    if (fresh.elements.some((e) => e.id === id)) return null; // still there → not a moved id
    const match = fresh.elements.find(
      (e) => e.tag === prev.tag && e.role === prev.role && e.name === prev.name,
    );
    return match ? match.id : null;
  }

  /** A cheap page fingerprint for change detection (url + title + interactive count). */
  private async fingerprint(): Promise<PageFingerprint> {
    try {
      const elementCount = await this.page.evaluate(
        () =>
          document.querySelectorAll(
            'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]',
          ).length,
      );
      return { url: this.page.url(), title: await this.page.title(), elementCount };
    } catch {
      // Page may be mid-navigation (execution context destroyed) — best effort,
      // so an in-flight nav doesn't turn a successful action into a spurious retry.
      return { url: this.page.url(), title: "", elementCount: -1 };
    }
  }

  private sel(id: string): string {
    return `[data-ai-id="${id}"]`;
  }
}

/** Launches and owns a browser; hands out AI-facing pages. */
export class AIBrowser {
  private constructor(private readonly browser: Browser) {}

  /** Headed by default so a human can watch — the "Pleasant" pillar. */
  static async launch(opts: LaunchOptions = { headless: false }): Promise<AIBrowser> {
    return new AIBrowser(await chromium.launch(opts));
  }

  async newPage(): Promise<AIPage> {
    return new AIPage(await this.browser.newPage());
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
