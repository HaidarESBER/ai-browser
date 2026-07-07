/**
 * AI-Native Browser Framework — live view (M5)
 *
 * A tiny, dependency-free observability server: open it in a browser tab to
 * WATCH the (headless) AI browse — a refreshing screenshot plus the live action
 * trace. This is the "Pleasant" pillar: supervision, not collaboration.
 *
 * Loopback-only, single-user, developer-facing — not a hardened public server.
 */
import { createServer, type Server } from "node:http";
import type { AIPage } from "./browser.js";

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Browser — Live View</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, monospace; background: #0b0e14; color: #cdd6f4; display: grid; grid-template-columns: 1fr 340px; height: 100vh; }
  #stage { display: flex; align-items: center; justify-content: center; padding: 16px; overflow: auto; }
  #frame { max-width: 100%; max-height: 100%; border: 1px solid #313244; border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,.5); }
  #side { border-left: 1px solid #1e2030; display: flex; flex-direction: column; min-height: 0; }
  #side h1 { margin: 0; padding: 14px 16px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #89b4fa; border-bottom: 1px solid #1e2030; display: flex; justify-content: space-between; align-items: center; }
  #status { font-size: 11px; letter-spacing: 0; text-transform: none; }
  #status.live { color: #a6e3a1; }
  #status.down { color: #f38ba8; }
  #events { flex: 1; overflow: auto; padding: 8px 0; margin: 0; list-style: none; }
  #events li { padding: 6px 16px; border-bottom: 1px solid #14161f; white-space: pre-wrap; word-break: break-word; }
  .k { display: inline-block; min-width: 66px; font-size: 11px; padding: 1px 6px; margin-right: 8px; border-radius: 4px; text-align: center; }
  .k.action { background: #1e3a2e; color: #a6e3a1; }
  .k.error { background: #3a1e26; color: #f38ba8; }
  .k.navigate, .k.back { background: #1e2a3a; color: #89b4fa; }
</style></head>
<body>
  <div id="stage"><img id="frame" alt="live page"></div>
  <div id="side"><h1>Action trace <span id="status" class="down">● connecting</span></h1><ul id="events"></ul></div>
<script>
  const img = document.getElementById('frame');
  const list = document.getElementById('events');
  const status = document.getElementById('status');
  function setStatus(up) {
    status.className = up ? 'live' : 'down';
    status.textContent = up ? '● live' : '● disconnected';
  }
  img.onerror = () => setStatus(false);
  function tickFrame() { img.src = '/frame?t=' + Date.now(); }
  async function tickEvents() {
    try {
      const r = await fetch('/events');
      if (!r.ok) throw new Error('bad status');
      const evs = await r.json();
      setStatus(true);
      // Build rows with textContent — never innerHTML — so page-derived strings
      // (URLs, element names, error messages) can't inject HTML into this origin.
      list.textContent = '';
      for (const e of evs.slice().reverse()) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.className = 'k ' + String(e.kind || '').replace(/[^a-z]/gi, '');
        span.textContent = e.kind;
        li.appendChild(span);
        li.appendChild(document.createTextNode(' ' + e.detail));
        list.appendChild(li);
      }
    } catch { setStatus(false); }
  }
  setInterval(tickFrame, 500);
  setInterval(tickEvents, 800);
  tickFrame(); tickEvents();
</script>
</body></html>`;

export class LiveView {
  private server: Server | null = null;
  private boundPort = 0;

  // S3: coalesce screenshots — serve a recent frame instead of one CDP capture
  // per request, so many viewers / fast polling don't contend with the AI's work.
  private lastFrame: { buf: Buffer; at: number } | null = null;
  private inflight: Promise<Buffer> | null = null;

  constructor(
    private readonly page: AIPage,
    private readonly port = 7333,
  ) {}

  /** Start the server; resolves with the URL to open. Falls back across ports if busy. */
  start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      try {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/frame") {
          const buf = await this.frame();
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
          res.end(buf);
          return;
        }
        if (path === "/events") {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(this.page.events()));
          return;
        }
        if (path === "/" || path === "") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(PAGE_HTML);
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      } catch {
        res.writeHead(503);
        res.end();
      }
    });

    const first = Number(process.env.AI_BROWSER_LIVE_PORT) || this.port;
    return this.listenWithFallback(first, first + 10);
  }

  /** Try ports [port..maxPort], stepping past any that are already in use (S1). */
  private listenWithFallback(port: number, maxPort: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.server!.removeListener("error", onError);
        if (err.code === "EADDRINUSE" && port < maxPort) {
          resolve(this.listenWithFallback(port + 1, maxPort));
        } else {
          reject(err);
        }
      };
      this.server!.once("error", onError);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.removeListener("error", onError);
        this.boundPort = port;
        resolve(`http://localhost:${port}`);
      });
    });
  }

  /** Return a fresh-enough JPEG frame, coalescing concurrent/rapid requests. */
  private async frame(): Promise<Buffer> {
    if (this.lastFrame && Date.now() - this.lastFrame.at < 250) return this.lastFrame.buf;
    if (this.inflight) return this.inflight;
    this.inflight = this.page.page
      .screenshot({ type: "jpeg", quality: 55 })
      .then((buf) => {
        this.lastFrame = { buf, at: Date.now() };
        this.inflight = null;
        return buf;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });
    return this.inflight;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
