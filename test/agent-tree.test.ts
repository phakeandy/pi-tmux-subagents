import { expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installTree, treeLines, statusLabel, type TaskView } from "../src/agent-tree.js";

const view: TaskView = { record: { id: "a", owner: "parent", token: "secret", title: "项目｜调查双风扇", task: "investigate", cwd: "/tmp", piArgs: [], createdAt: 1, mode: "delegated", round: "one", windowId: "@7", paneId: "%8", tmuxSocket: "/tmp/socket" }, state: { mode: "delegated", status: "waiting", reportPending: false, handoff: true, round: "one", updatedAt: 1, delivery: "sent" }, exists: true, alive: true };
const theme = { fg: (_color: string, text: string) => text };
test("settled means reported/waiting, not accepted; dead pane overrides last running state", () => {
  expect(statusLabel(view)).toBe("Reported · waiting");
  expect(statusLabel({ ...view, alive: false, state: { ...view.state!, status: "running" } })).toBe("Exited");
  expect(statusLabel({ ...view, state: { ...view.state!, mode: "user", handoff: false } })).toBe("Waiting for you");
  expect(statusLabel({ ...view, state: { ...view.state!, delivery: "unsent" } })).toBe("Not delivered");
});
test.each([1, 8, 20, 80])("tree fits terminal columns at width %i, including Chinese titles", width => {
  const lines = treeLines([view], width, theme, undefined);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
});
test("idle entries persist and list height is bounded with selected old entries reachable", () => {
  const views = Array.from({ length: 30 }, (_, i) => ({ ...view, record: { ...view.record, title: `item-${i}` } }));
  const lines = treeLines(views, 100, theme, 0);
  expect(lines.join("\n")).toContain("item-0");
  expect(lines.length).toBeLessThanOrEqual(11);
  expect(lines.join("\n")).toContain("Agents (30)");
});
test("empty editor arrows navigate, Enter enters selected pane, Esc returns without hijacking text/dialogs", async () => {
  let raw: any;
  let text = "";
  const editor = { getText: () => text };
  let focus: any = editor;
  const tui = { getFocusedComponent: () => focus, hasOverlay: () => false, requestRender: vi.fn() };
  const open = vi.fn(async () => {});
  const ctx = { hasUI: true, isIdle: () => true, ui: { getEditorText: () => text, notify: vi.fn(), onTerminalInput: (fn: any) => { raw = fn; return vi.fn(); }, setWidget: (_key: string, fn: any) => { if (fn) fn(tui, theme); } } } as unknown as ExtensionContext;
  const second = { ...view, record: { ...view.record, id: "b", paneId: "%9" } };
  const tree = installTree(ctx, () => [view, second], open);
  text = "draft";
  expect(raw("\x1b[B")).toBeUndefined();
  text = ""; focus = { getValue: () => "selector" };
  expect(raw("\x1b[B")).toBeUndefined();
  focus = editor;
  expect(raw("\x1b[B")).toEqual({ consume: true });
  raw("\x1b[B"); raw("\r");
  expect(open).toHaveBeenCalledWith(second);
  raw("\x1b[D"); expect(raw("\x1b")).toEqual({ consume: true });
  expect(raw("\r")).toBeUndefined();
  tree.close();
});

test("tree titles do not repeat keyboard usage hints, even while selected", () => {
  expect(treeLines([view], 100, theme, undefined)[0]).toBe("● Agents (1)");
  expect(treeLines([view], 100, theme, 0)[0]).toBe("● Agents (1)");
});

test("reference-style rows show real activity, tools, turns and tokens, retaining finished duration", () => {
  const now = Date.now();
  const running = { ...view, state: { ...view.state!, status: "running" as const, turns: 5, toolUses: 5, tokens: 33800, contextPercent: 62, startedAt: now - 12300, activity: "Editing 2 files…" } };
  const lines = treeLines([running], 160, theme, undefined).join("\n");
  expect(lines).toContain("● Agents");
  expect(lines).toContain("↻5 · 5 tool uses · 33.8k token (62%)");
  expect(lines).toContain("⎿  Editing 2 files…");
  const stopped = { ...running, state: { ...running.state, status: "waiting" as const, endedAt: now - 10000, startedAt: now - 22300 } };
  const stoppedLines = treeLines([stopped], 160, theme, undefined).join("\n");
  expect(stoppedLines).toContain("12.3s");
  expect(stoppedLines).not.toContain("空闲");
  expect(stoppedLines.toLowerCase()).not.toContain("idle");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60000);
  try { expect(treeLines([stopped], 160, theme, undefined).join("\n")).toBe(stoppedLines); }
  finally { clock.mockRestore(); }
});
