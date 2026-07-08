/**
 * ecobrowser — AI-native browser framework
 *
 * Public package entry point. The core engine (AIBrowser / AIPage) is the
 * product; LiveView is the optional human-observability side channel. The MCP
 * server ships as the `ecobrowser-mcp` bin, not as an importable module.
 */
export {
  AIBrowser,
  AIPage,
  computeSnapshotDiff,
  elementMatchScore,
  isBlockedNavigation,
  type ActionResult,
  type ConsoleEntry,
  type Link,
  type NetworkEntry,
  type PageEvent,
  type PageFingerprint,
  type ReliabilityOptions,
  type Snapshot,
  type SnapshotDiff,
  type SnapshotElement,
} from "./browser.js";
export { LiveView } from "./live.js";
