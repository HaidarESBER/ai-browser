/**
 * Unit tests for the pure logic that the audit fixed — runnable without a browser.
 * Run with: npm test
 */
import assert from "node:assert/strict";
import {
  computeSnapshotDiff,
  elementMatchScore,
  isBlockedNavigation,
  type Snapshot,
  type SnapshotElement,
} from "./browser.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const el = (tag: string, name: string, value?: string) => ({
  id: "e",
  role: tag,
  name,
  tag,
  ...(value !== undefined ? { value } : {}),
});
const snap = (elements: SnapshotElement[]): Snapshot => ({ url: "x", title: "t", elements });

console.log("computeSnapshotDiff (M3 — duplicate handling):");

check("detects one of three identical elements removed", () => {
  const prev = snap([el("button", "Add"), el("button", "Add"), el("button", "Add")]);
  const next = snap([el("button", "Add"), el("button", "Add")]);
  const d = computeSnapshotDiff(prev, next);
  assert.equal(d.removed.length, 1);
  assert.equal(d.added.length, 0);
  assert.equal(d.unchanged, 2);
});

check("detects an added unique element", () => {
  const prev = snap([el("a", "Home")]);
  const next = snap([el("a", "Home"), el("button", "New")]);
  const d = computeSnapshotDiff(prev, next);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0]?.name, "New");
});

check("detects a value change on an input", () => {
  const prev = snap([el("input", "Search", "")]);
  const next = snap([el("input", "Search", "hello")]);
  const d = computeSnapshotDiff(prev, next);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0]?.to, 'value="hello"');
});

check("no changes on identical snapshots", () => {
  const s = snap([el("a", "One"), el("a", "Two")]);
  const d = computeSnapshotDiff(s, s);
  assert.equal(d.added.length + d.removed.length + d.changed.length, 0);
  assert.equal(d.unchanged, 2);
});

console.log("\nisBlockedNavigation (H3 — navigation guard):");

check("blocks file:// URLs", () => assert.equal(isBlockedNavigation("file:///C:/secret.txt"), true));
check("blocks javascript: URLs", () => assert.equal(isBlockedNavigation("javascript:alert(1)"), true));
check("blocks chrome:// URLs", () => assert.equal(isBlockedNavigation("chrome://settings"), true));
check("allows https URLs", () => assert.equal(isBlockedNavigation("https://example.com"), false));
check("allows scheme-less URLs", () => assert.equal(isBlockedNavigation("example.com"), false));
check("allows data: fixtures", () => assert.equal(isBlockedNavigation("data:text/html,<h1>hi</h1>"), false));
check("allowLocal opt-out unblocks file://", () =>
  assert.equal(isBlockedNavigation("file:///x", true), false));

console.log("\nelementMatchScore (find):");

check("exact name beats partial", () =>
  assert.ok(elementMatchScore(el("button", "Sign in"), "Sign in") > elementMatchScore(el("button", "Sign in now"), "Sign in")));
check("substring match scores > 0", () => assert.ok(elementMatchScore(el("input", "Search query"), "search") > 0));
check("all-words-present match", () => assert.ok(elementMatchScore(el("a", "Create new account"), "account create") > 0));
check("no match scores 0", () => assert.equal(elementMatchScore(el("a", "Home"), "checkout"), 0));

console.log("\nelementMatchScore (kind hints):");

check("'search box' matches an input even though no element says 'box'", () =>
  assert.ok(elementMatchScore(el("input", "Search Wikipedia"), "search box") > 0));
check("'search box' ranks the input above the Search button", () =>
  assert.ok(
    elementMatchScore(el("input", "Search Wikipedia"), "search box") >
      elementMatchScore(el("button", "Search"), "search box"),
  ));
check("kind mismatch demotes but keeps a strong name match", () =>
  assert.ok(elementMatchScore(el("button", "Search"), "search box") > 0));
check("a kind word alone matches by kind", () => {
  assert.ok(elementMatchScore(el("button", "Go"), "button") > 0);
  assert.equal(elementMatchScore(el("a", "Go"), "button"), 0);
});
check("'login button' boosts the Login button over a Login link", () =>
  assert.ok(
    elementMatchScore(el("button", "Login"), "login button") >
      elementMatchScore(el("a", "Login"), "login button"),
  ));
check("kind hint alone never matches an unrelated name", () =>
  assert.equal(elementMatchScore(el("input", "Email"), "search box"), 0));

console.log("\ncomputeSnapshotDiff (state changes):");

check("detects a checkbox toggling to checked", () => {
  const prev = snap([{ id: "e", role: "checkbox", name: "Agree", tag: "input" }]);
  const next = snap([{ id: "e", role: "checkbox", name: "Agree", tag: "input", state: ["checked"] }]);
  const d = computeSnapshotDiff(prev, next);
  assert.equal(d.changed.length, 1);
  assert.equal(d.unchanged, 0);
});

console.log(`\n✅ ${passed} tests passed.`);
