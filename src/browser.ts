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

/** Options for goto() — escape hatches for slow or bot-wary sites. */
export interface GotoOptions {
  /** Navigation timeout in ms (Playwright default: 30 000). */
  timeoutMs?: number;
  /** When to consider navigation done (default "load"; "domcontentloaded" or "commit" for pages that never settle). */
  waitUntil?: "load" | "domcontentloaded" | "commit" | "networkidle";
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
  /** Hash of the interactive elements' text, values and states (checked, expanded, …). */
  stateHash: string;
}

/** Structured outcome of a reliable action — tells the AI exactly what happened. */
export interface ActionResult {
  ok: boolean;
  action: string;
  changed: boolean;
  attempts: number;
  detail: string;
  error?: string;
  /** The action failed after it may already have taken effect, so it was not retried. */
  maybeApplied?: boolean;
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

/** An action failed after it may already have been dispatched — retrying could repeat it. */
class MaybeAppliedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Cap on retained console/network entries per page, to bound memory (M1). */
const MAX_LOG = 500;

/** Strip ANSI colour/escape codes (Playwright error messages contain them). */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

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
 * True if two field values hold the same letters and digits in the same order —
 * i.e. the field only re-formatted what was typed ("0612345678" → "06 12 34 56 78").
 */
export function sameCharacters(a: string, b: string): boolean {
  const core = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return core(a) !== "" && core(a) === core(b);
}

/**
 * Diff two snapshots. An element whose id is unique in both snapshots is the
 * same element (ids are durable), so a relabelled button shows up as changed
 * rather than removed + added. The rest are keyed by semantic signature
 * (tag|role|name) plus an occurrence index, so repeated identical elements
 * (e.g. five identical buttons) are matched positionally instead of collapsing
 * to one key.
 */
export function computeSnapshotDiff(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const uniqueIds = (s: Snapshot) => {
    const count = new Map<string, number>();
    for (const e of s.elements) count.set(e.id, (count.get(e.id) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n === 1).map(([id]) => id));
  };
  const prevIds = uniqueIds(prev);
  const nextIds = uniqueIds(next);
  const stable = new Set([...prevIds].filter((id) => nextIds.has(id)));

  const makeKeyer = () => {
    const seen = new Map<string, number>();
    return (e: SnapshotElement) => {
      if (stable.has(e.id)) return `id:${e.id}`;
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

  const desc = (x: SnapshotElement, other: SnapshotElement) => {
    const parts: string[] = [];
    if (x.name !== other.name) parts.push(`name="${x.name}"`);
    if (x.value !== undefined) parts.push(`value="${x.value}"`);
    if (x.state?.length) parts.push(`[${x.state.join(",")}]`);
    return parts.join(" ") || "∅";
  };

  const changed: SnapshotDiff["changed"] = [];
  let unchanged = 0;
  for (const [k, e] of nextEntries) {
    const p = prevMap.get(k);
    if (!p) continue;
    // Changed if the label, value OR state flags differ (e.g. a checkbox toggled).
    if (
      p.name !== e.name ||
      p.value !== e.value ||
      (p.state ?? []).join(",") !== (e.state ?? []).join(",")
    ) {
      changed.push({ id: e.id, name: e.name, from: desc(p, e), to: desc(e, p) });
    } else {
      unchanged++;
    }
  }
  return { added, removed, changed, unchanged };
}

/**
 * Query words that describe the KIND of element rather than its name
 * ("search box" names nothing containing the word "box" — it means an input).
 * Each maps to the tags/roles it implies.
 */
const KIND_HINTS: Record<string, string[]> = {
  box: ["input", "textarea", "select", "searchbox", "textbox", "combobox"],
  field: ["input", "textarea", "searchbox", "textbox"],
  input: ["input", "textarea", "searchbox", "textbox"],
  textbox: ["input", "textarea", "searchbox", "textbox"],
  textarea: ["textarea"],
  button: ["button"],
  btn: ["button"],
  link: ["a", "link"],
  checkbox: ["input", "checkbox"],
  radio: ["input", "radio"],
  dropdown: ["select", "combobox", "listbox"],
};

/**
 * Score how well an element matches a natural-language query. Deterministic —
 * no LLM — so `find()` is cheap. Kind words ("box", "button", "link") are
 * matched against the element's tag/role — a kind match boosts, a kind
 * mismatch demotes (so "search box" ranks the search input above the Search
 * button). The remaining words score against the accessible name:
 * exact beats prefix beats substring beats all-words-present.
 */
export function elementMatchScore(e: SnapshotElement, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const name = e.name.toLowerCase();
  const hay = `${name} ${e.role} ${e.tag}`.toLowerCase();

  const kinds = new Set<string>();
  const nameWords: string[] = [];
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const hint = KIND_HINTS[w];
    if (hint) hint.forEach((k) => kinds.add(k));
    else nameWords.push(w);
  }
  const kindMatch = kinds.size
    ? kinds.has(e.tag.toLowerCase()) || kinds.has(e.role.toLowerCase())
    : null;

  const target = nameWords.join(" ");
  if (!target) return kindMatch ? 40 : 0; // query was only kind words, e.g. "button"

  let base = 0;
  if (name === target) base = 100;
  else if (name.startsWith(target)) base = 70;
  else if (name.includes(target)) base = 50;
  else if (nameWords.every((w) => hay.includes(w))) base = 30;
  else if (hay.includes(q)) base = 20;
  if (base === 0) return 0;

  if (kindMatch === true) base += 20;
  if (kindMatch === false) base -= 40;
  return Math.max(0, base);
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
  // Count real navigations, so an action that navigates is reliably "page changed"
  // even if the fingerprint is captured mid-transition.
  private navCount = 0;
  // Next element id to hand out — owned here, not by the document, so ids are
  // unique for the life of this AIPage across every page it visits.
  private nextId = 0;
  // Identity of the document the last snapshot was taken from.
  private lastDocId: string | null = null;

  // The navigation's own document response — held aside so the per-page log
  // wipe below doesn't erase the very request that produced the current page.
  private pendingDocResponse: NetworkEntry | null = null;

  constructor(public readonly page: Page) {
    // CHECK: tap console + page errors + network as they happen (first-class).
    page.on("console", (msg) =>
      this.pushCapped(this.consoleLog, { type: msg.type(), text: msg.text(), ts: Date.now() }),
    );
    page.on("pageerror", (err) =>
      this.pushCapped(this.consoleLog, { type: "error", text: err.message, ts: Date.now() }),
    );
    page.on("response", (res) => {
      const entry: NetworkEntry = {
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        ts: Date.now(),
      };
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        this.pendingDocResponse = entry;
      }
      this.pushCapped(this.networkLog, entry);
    });
    // Logs describe the CURRENT page: reset them when the main frame navigates —
    // but keep the document request itself, so network() is never empty after goto().
    page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) return;
      this.clearLogs();
      if (this.pendingDocResponse) {
        this.networkLog.push(this.pendingDocResponse);
        this.pendingDocResponse = null;
      }
      // Track EVERY navigation (Enter submits, form posts, link clicks), not just
      // goto() — so the trace reflects real page changes and change-detection is reliable.
      const url = this.page.url();
      if (url && url !== "about:blank") {
        this.navCount++;
        this.record("navigate", url);
      }
    });
  }

  private pushCapped<T>(log: T[], entry: T): void {
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
  }

  /**
   * Run an in-page evaluation that survives a navigation racing it. The
   * canonical agent pattern — type, press Enter, look — destroys the JS
   * execution context mid-look; instead of letting that escape as a crash,
   * wait for the new document and retry. (Absorb the recovery in code so the
   * model doesn't have to.)
   */
  private async withContextRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const contextLost =
          /execution context was destroyed|cannot find context|frame was detached|navigation/i.test(
            message,
          );
        if (!contextLost || attempt >= attempts) throw err;
        await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await sleep(150 * attempt);
      }
    }
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
    const out = await this.withContextRetry(() => this.page.evaluate((firstId) => {
      const SELECTOR =
        'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]';
      const results: SnapshotElement[] = [];
      // Durable ids: we REUSE any id already stamped on an element — so a surviving
      // element keeps the same id across snapshots. New ids come from a counter
      // owned by the AIPage (not the document), so an id is never handed out twice,
      // even after a navigation: a stale id from a previous page can't silently
      // land on a different element of the new one.
      let nextId = firstId;
      const seen = new Set<string>();
      const w = window as unknown as { __aiDocId?: string };
      if (w.__aiDocId === undefined) w.__aiDocId = Math.random().toString(36).slice(2);

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

        // A node cloned by the page (innerHTML copy, template) carries its
        // original's id — re-stamp duplicates so every id targets one element.
        let id = el.getAttribute("data-ai-id");
        if (!id || seen.has(id)) {
          id = `e${nextId++}`;
          el.setAttribute("data-ai-id", id);
        }
        seen.add(id);

        // .labels covers both <label for=…> and label-wrapped inputs, which
        // otherwise have no accessible name at all (common on plain HTML forms).
        const labels = (el as HTMLInputElement).labels;
        const labelText = labels?.length
          ? (labels[0].innerText || labels[0].textContent || "").trim().replace(/\s+/g, " ")
          : "";
        const name =
          (el as HTMLElement).innerText?.trim() ||
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          labelText ||
          el.getAttribute("title") ||
          "";

        const entry: SnapshotElement = {
          id,
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          name: name.slice(0, 120),
          tag: el.tagName.toLowerCase(),
        };
        const value = (el as HTMLInputElement).value;
        // Never put a secret into the model's context (or the diff / trace):
        // a password field only reports THAT it holds something.
        const secret = el.matches("input[type=password]");
        if (value) entry.value = secret ? "[redacted]" : value.slice(0, 120);

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
      return { elements: results, nextId, docId: w.__aiDocId };
    }, this.nextId));

    this.nextId = Math.max(this.nextId, out.nextId);
    this.lastDocId = out.docId;
    return { url: this.page.url(), title: await this.page.title(), elements: out.elements };
  }

  /**
   * Cheap DOM-version read for cache invalidation. Installs (once per page) a
   * MutationObserver that counts real DOM changes — ignoring our own data-ai-id
   * tagging so building a snapshot never invalidates its own cache.
   */
  private async domVersion(): Promise<number> {
    return this.withContextRetry(() => this.page.evaluate(() => {
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
    }));
  }

  /** Pixels, on demand only — for when structure isn't enough. */
  async screenshot(path?: string): Promise<Buffer> {
    return this.page.screenshot(path ? { path } : undefined);
  }

  /** Full visible text of the page. */
  async readText(): Promise<string> {
    const text = await this.withContextRetry(() => this.page.evaluate(() => document.body.innerText));
    this.record("action", `read page text (${text.length} chars)`);
    return text;
  }

  /**
   * Find interactive elements matching a natural-language description, ranked —
   * so the AI can ask for "the search box" and get just the match(es) instead of
   * reading a whole-page snapshot. Deterministic (no LLM).
   */
  async find(query: string, limit = 5): Promise<SnapshotElement[]> {
    const snap = await this.snapshot({ cache: true });
    const results = snap.elements
      .map((e) => ({ e, score: elementMatchScore(e, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
    this.record("action", `find "${query}" (${results.length} match${results.length === 1 ? "" : "es"})`);
    return results;
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

  async goto(url: string, opts: GotoOptions = {}): Promise<void> {
    if (isBlockedNavigation(url, process.env.AI_BROWSER_ALLOW_LOCAL === "1")) {
      throw new Error(
        `navigation to "${url}" is blocked (local-file/privileged scheme). Set AI_BROWSER_ALLOW_LOCAL=1 to allow.`,
      );
    }
    await this.page.goto(url, { timeout: opts.timeoutMs, waitUntil: opts.waitUntil });
    // navigation is recorded by the framenavigated listener
  }

  async back(): Promise<void> {
    await this.page.goBack();
    // navigation is recorded by the framenavigated listener
  }

  async forward(): Promise<void> {
    await this.page.goForward();
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  /**
   * CORRECT: wait until the page has settled (network idle) before acting.
   * Bounded short on purpose: pages with analytics beacons, chat widgets or
   * polling never go network-idle, and every action would pay the full timeout.
   */
  async waitUntilReady(timeoutMs = 3000): Promise<void> {
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
      // Wait for actionability WITHOUT clicking — failures up to here are safe to retry.
      await this.page.click(sel, { timeout: 10000, trial: true });
      try {
        await this.page.click(sel, { timeout: 5000 });
      } catch (err) {
        // The click may have been dispatched (submit, purchase…): never repeat it.
        throw new MaybeAppliedError(err);
      }
    });
  }

  /**
   * Type into a field by id, then verify the typed value actually landed. A field
   * that reformats input (phone / card / currency masks) still counts as success
   * when the same letters and digits landed; the result says what it now holds.
   */
  async typeById(id: string, text: string): Promise<ActionResult> {
    let reformatted: string | null = null;
    const result = await this.reliableOnElement(id, "type into", async (sel) => {
      reformatted = null;
      await this.page.waitForSelector(sel, { state: "visible", timeout: 5000 });
      await this.page.fill(sel, text);
      const actual = await this.page.inputValue(sel);
      if (actual !== text && sameCharacters(actual, text)) {
        const secret = await this.page
          .$eval(sel, (el) => el.matches("input[type=password]"))
          .catch(() => true);
        if (!secret) reformatted = actual;
        return;
      }
      if (actual !== text) {
        const secret = await this.page
          .$eval(sel, (el) => el.matches("input[type=password]"))
          .catch(() => true);
        throw new Error(
          secret
            ? "password field value did not match after typing (value redacted)"
            : `field holds "${actual}" after typing, expected "${text}"`,
        );
      }
    });
    if (result.ok && reformatted !== null) {
      result.detail += ` The field reformatted the input to "${reformatted}".`;
    }
    return result;
  }

  /** Select an option by id, with reliability + self-healing. */
  async selectById(id: string, value: string): Promise<ActionResult> {
    return this.reliableOnElement(id, `select "${value}" in`, async (sel) => {
      await this.page.waitForSelector(sel, { state: "visible", timeout: 5000 });
      await this.page.selectOption(sel, value, { timeout: 10000 });
    });
  }

  /** Hover an element by id, with reliability + self-healing (hovering twice is harmless). */
  async hoverById(id: string): Promise<ActionResult> {
    return this.reliableOnElement(id, "hover", async (sel) => {
      await this.page.waitForSelector(sel, { state: "visible", timeout: 5000 });
      await this.page.hover(sel, { timeout: 10000 });
    });
  }

  /** Scroll the page; reports whether anything new appeared. Not retried. */
  async scrollBy(dy: number): Promise<ActionResult> {
    return this.reliable(`scroll ${dy >= 0 ? "down" : "up"}`, () => this.page.mouse.wheel(0, dy), {
      retries: 0,
    });
  }

  /** Press a key (e.g. "Enter", "Escape", "Control+A"). Not retried — Enter twice submits twice. */
  async press(key: string): Promise<ActionResult> {
    return this.reliable(`press ${key}`, () => this.page.keyboard.press(key), { retries: 0 });
  }

  // ---- MANIPULATE ---------------------------------------------------------

  /** Run arbitrary JS in the page. */
  async evaluate<T>(fn: string): Promise<T> {
    const result = (await this.page.evaluate(fn)) as T;
    this.record("action", "evaluate JS");
    return result;
  }

  // ---- EXTRACT ------------------------------------------------------------

  /** Deterministic extraction of all links (LLM-schema extraction comes later). */
  async extractLinks(): Promise<Link[]> {
    const links = await this.withContextRetry(() =>
      this.page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]")).map((a) => ({
          name: (a as HTMLElement).innerText.trim().slice(0, 120),
          href: (a as HTMLAnchorElement).href,
        })),
      ),
    );
    this.record("action", `extract links (${links.length} found)`);
    return links;
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
    const navBefore = this.navCount;

    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      attempts = attempt;
      try {
        await fn();
        await this.waitUntilReady(opts.settleTimeoutMs ?? 1500);
        const after = await this.fingerprint();
        const changed =
          this.navCount > navBefore ||
          before.url !== after.url ||
          before.title !== after.title ||
          before.elementCount !== after.elementCount ||
          before.stateHash !== after.stateHash;
        const detail = `${action} succeeded${changed ? " (page changed)" : " (no visible page change)"}.`;
        this.record("action", detail);
        return { ok: true, action, changed, attempts: attempt, before, after, detail };
      } catch (err) {
        lastError = err;
        if (err instanceof MaybeAppliedError) break;
        if (attempt <= retries) await sleep(backoffMs * attempt);
      }
    }

    const after = await this.fingerprint().catch(() => before);
    const message = stripAnsi(lastError instanceof Error ? lastError.message : String(lastError));
    const maybeApplied = lastError instanceof MaybeAppliedError;
    const hint = maybeApplied
      ? " It may already have taken effect — check the page before trying again."
      : /selector|timeout/i.test(message)
        ? " The element may no longer exist — take a fresh snapshot and retry."
        : "";
    const detail = `${action} failed after ${attempts} attempt(s): ${message}.${hint}`;
    this.record("error", detail);
    return {
      ok: false,
      action,
      changed: false,
      attempts,
      before,
      after,
      error: message,
      detail,
      ...(maybeApplied ? { maybeApplied } : {}),
    };
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
    if (first.ok || first.maybeApplied) return first;

    const newId = await this.healId(id);
    if (!newId) return first;

    return this.reliable(`${verb} ${id} (re-located as ${newId})`, () => act(this.sel(newId)));
  }

  /**
   * Self-heal: if the original id has vanished from the page, find a replacement
   * element with the same identity (tag/role/name) and return its new id. Returns
   * null — refusing to guess — if the id still exists (a real failure, not a moved
   * id), the page is now a different document, or the identity is ambiguous (two
   * "Delete" buttons before or after): acting on the wrong one is worse than failing.
   */
  private async healId(id: string): Promise<string | null> {
    const prevSnap = this.lastSnapshot;
    const prevDoc = this.lastDocId;
    const prev = prevSnap?.elements.find((e) => e.id === id);
    if (!prevSnap || !prev) return null;
    const fresh = await this.buildSnapshot();
    this.lastSnapshot = fresh;
    this.lastDomVersion = await this.domVersion();
    if (fresh.elements.some((e) => e.id === id)) return null; // still there → not a moved id
    if (this.lastDocId !== prevDoc) return null; // navigated: nothing to re-locate
    const same = (e: SnapshotElement) =>
      e.tag === prev.tag && e.role === prev.role && e.name === prev.name;
    if (prevSnap.elements.filter(same).length !== 1) return null;
    const matches = fresh.elements.filter(same);
    return matches.length === 1 ? matches[0]!.id : null;
  }

  /**
   * A cheap page fingerprint for change detection: url + title + interactive
   * count, plus a hash of each interactive element's label, value and state — so
   * a toggled checkbox, an opened menu or a relabelled button counts as a change
   * even when no element was added or removed.
   */
  private async fingerprint(): Promise<PageFingerprint> {
    try {
      const { elementCount, stateHash } = await this.page.evaluate(() => {
        const els = document.querySelectorAll(
          'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]',
        );
        // (No helper functions in here: bundlers wrap them in helpers that don't
        // exist inside the page.)
        const parts: string[] = [];
        for (const el of Array.from(els)) {
          const inp = el as HTMLInputElement;
          parts.push(
            el.tagName,
            ((el as HTMLElement).innerText ?? "").slice(0, 80),
            String(inp.value ?? ""),
            inp.checked ? "1" : "0",
            inp.disabled ? "1" : "0",
            el.getAttribute("aria-expanded") ?? "",
            el.getAttribute("aria-checked") ?? "",
            el.getAttribute("aria-selected") ?? "",
            el.getAttribute("aria-pressed") ?? "",
          );
        }
        parts.push(String(document.querySelectorAll("dialog[open], [role=dialog], [aria-modal=true]").length));
        const all = parts.join("|");
        let h = 5381;
        for (let i = 0; i < all.length; i++) h = ((h * 33) ^ all.charCodeAt(i)) >>> 0;
        return { elementCount: els.length, stateHash: h.toString(36) };
      });
      return { url: this.page.url(), title: await this.page.title(), elementCount, stateHash };
    } catch {
      // Page may be mid-navigation (execution context destroyed) — best effort,
      // so an in-flight nav doesn't turn a successful action into a spurious retry.
      return { url: this.page.url(), title: "", elementCount: -1, stateHash: "" };
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
