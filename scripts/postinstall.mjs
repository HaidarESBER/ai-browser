/**
 * Post-install: fetch the Chromium build Playwright drives, so `npm install
 * ecobrowser` is all a user needs. Never fails the install — offline machines,
 * CI images and locked-down networks get a hint instead of a broken
 * `npm install`. Skipped when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD or
 * ECOBROWSER_SKIP_BROWSER_DOWNLOAD is set (e.g. browsers are provisioned separately).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const HINT = "[ecobrowser] Fetch the browser later with: npx playwright install chromium";

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD || process.env.ECOBROWSER_SKIP_BROWSER_DOWNLOAD) {
  console.log(`[ecobrowser] Skipping the Chromium download (skip variable set).\n${HINT}`);
  process.exit(0);
}

try {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  const { status, error } = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  if (error || status !== 0) throw error ?? new Error(`exit code ${status}`);
} catch (err) {
  console.warn(`[ecobrowser] Could not download Chromium (${err.message}); the package is installed anyway.\n${HINT}`);
}
