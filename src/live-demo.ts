/**
 * Watchable live demo: drives a headless browser through a multi-step task on a
 * loop while the live view server stays up, so you can open the URL and watch.
 */
import { AIBrowser, type AIPage } from "./browser.js";
import { LiveView } from "./live.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sequence(page: AIPage, round: number) {
  console.log(`\n— round ${round} —`);

  await page.goto("https://example.com");
  await page.waitUntilReady();
  await wait(2500);

  const snap = await page.snapshot();
  const link = snap.elements.find((e) => e.tag === "a");
  if (link) {
    console.log("click 'Learn more'");
    await page.clickById(link.id);
    await wait(2500);
  }

  await page.scrollBy(400);
  await wait(1800);

  await page.goto("https://news.ycombinator.com");
  await page.waitUntilReady();
  await wait(2500);
  await page.scrollBy(500);
  await wait(1800);

  await page.goto("https://en.wikipedia.org/wiki/Web_browser");
  await page.waitUntilReady();
  await wait(2500);
  await page.scrollBy(700);
  await wait(1800);
}

async function main() {
  const browser = await AIBrowser.launch({ headless: true });
  const page = await browser.newPage();

  const live = new LiveView(page);
  const url = await live.start();
  console.log(`LIVE VIEW READY: ${url}`);

  const rounds = 6;
  for (let i = 1; i <= rounds; i++) await sequence(page, i);

  await wait(4000);
  await live.stop();
  await browser.close();
  console.log("\nLive demo finished.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
