import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { TaskRecord, ChildState } from "./task-store.js";

export interface TaskView { record: TaskRecord; state?: ChildState; alive: boolean; exists: boolean }
export function statusLabel(view: TaskView): string {
  if (!view.exists) return "Pane closed";
  if (!view.alive) return "Exited";
  const s = view.state;
  if (!s) return "Starting";
  if (s.status === "running") return s.delivery === "unsent" ? "Running · report not delivered" : "Running";
  if (s.delivery === "unsent") return "Not delivered";
  if (s.status === "error") return "Blocked";
  if (s.status === "waiting" && s.reportPending) return "Pending";
  if (s.mode === "user") return s.handoff ? "Awaiting delegation" : "Waiting for you";
  return "Reported · waiting";
}
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
}
export function formatTokens(n: number): string { return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}m`; }
export function treeLines(views: TaskView[], width: number, theme: Pick<Theme, "fg">, selected: number | undefined, frame = 0): string[] {
  if (!views.length) return [];
  const cap = 4;
  const start = selected === undefined ? Math.max(0, views.length - cap) : Math.max(0, Math.min(selected - cap + 1, views.length - cap));
  const end = Math.min(views.length, start + cap);
  const heading = views.some(v => v.alive && v.state?.status === "running") ? "accent" : "muted";
  const lines = [theme.fg(heading, "● Agents") + theme.fg("dim", ` (${views.length})`)];
  if (start) lines.push(theme.fg("dim", `│  ↑ ${start} more`));
  for (let i = start; i < end; i++) {
    const view = views[i]; const s = view.state;
    const running = view.alive && s?.status === "running";
    const last = i === end - 1;
    const icon = running ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame % 10] : !view.alive ? "○" : s?.status === "error" || s?.delivery === "unsent" ? "!" : "·";
    const color = !view.alive || s?.status === "error" || s?.delivery === "unsent" ? "warning" : running ? "accent" : "muted";
    const parts: string[] = [];
    if (s?.turns) parts.push(`↻${s.turns}`);
    if (s?.toolUses) parts.push(`${s.toolUses} tool use${s.toolUses === 1 ? "" : "s"}`);
    if (s?.tokens) parts.push(`${formatTokens(s.tokens)} token${typeof s.contextPercent === "number" ? ` (${Math.round(s.contextPercent)}%)` : ""}`);
    if (s?.startedAt && (running || s.endedAt)) parts.push(formatDuration((running ? Date.now() : s.endedAt!) - s.startedAt));
    const actor = s?.mode === "user" ? "Chat" : "Agent";
    const prefix = `${theme.fg("dim", last ? "└─" : "├─")} ${i === selected ? theme.fg("accent", "❯") : theme.fg(color, icon)} ${theme.fg(color, `\x1b[1m${actor}\x1b[22m`)}  `;
    const minimumTitle = Math.min(visibleWidth(view.record.title), Math.max(12, Math.floor(width * 0.45)));
    const deferred: string[] = [];
    while (parts.length > 1 && visibleWidth(prefix) + minimumTitle + visibleWidth(` · ${parts.join(" · ")}`) > width) {
      const token = parts.findIndex(part => part.includes("token"));
      const turn = parts.findIndex(part => part.startsWith("↻"));
      deferred.push(...parts.splice(token >= 0 ? token : turn >= 0 ? turn : 0, 1));
    }
    const metrics = parts.length ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
    const titleWidth = Math.max(8, width - visibleWidth(prefix) - visibleWidth(metrics));
    lines.push(`${prefix}${theme.fg("muted", truncateToWidth(view.record.title, titleWidth))}${metrics}`);
    const activity = running ? s?.activity ?? "Thinking…" : statusLabel(view);
    lines.push(theme.fg("dim", `${last ? "   " : "│  "}  ⎿  ${activity}${deferred.length ? ` · ${deferred.join(" · ")}` : ""}`));
  }
  if (end < views.length) lines.push(theme.fg("dim", `   ↓ ${views.length - end} more`));
  return lines.map(line => truncateToWidth(line, width));
}
/** A passive widget plus focused navigation, without replacing another extension's editor. */
export function installTree(ctx: ExtensionContext, getViews: () => TaskView[], open: (view: TaskView) => Promise<void>, remove?: (view: TaskView) => Promise<void>): { refresh: () => void; close: () => void } {
  let tui: TUI | undefined;
  let selected: number | undefined;
  let frame = 0;
  let editorFocus: unknown;
  const refresh = () => { frame++; tui?.requestRender(); };
  ctx.ui.setWidget("tmux-subagents", (terminal, theme) => {
    tui = terminal;
    return { render: (width: number) => treeLines(getViews(), width, ctx.ui.theme ?? theme, selected, frame), invalidate: () => {} };
  });
  const unsubscribe = ctx.ui.onTerminalInput(data => {
    // Only main editor focus, never selectors, overlays, nonempty text or active work.
    const focus = (tui as (TUI & { getFocusedComponent?: () => unknown }) | undefined)?.getFocusedComponent?.();
    const editor = focus as { getText?: () => string } | null;
    if (!ctx.isIdle() || !editor?.getText || ctx.ui.getEditorText() !== "" || editor.getText() !== "" || tui?.hasOverlay()) { selected = undefined; return; }
    const views = getViews();
    if (!views.length) return;
    if (selected === undefined) {
      if (matchesKey(data, "down") || matchesKey(data, "left")) { selected = 0; editorFocus = focus; refresh(); return { consume: true }; }
      return;
    }
    if (editorFocus !== focus) { selected = undefined; return; }
    selected = Math.min(selected, views.length - 1);
    if (matchesKey(data, "escape")) selected = undefined;
    else if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
    else if (matchesKey(data, "down")) selected = Math.min(views.length - 1, selected + 1);
    else if (matchesKey(data, "delete") && remove) {
      const view = views[selected]; selected = undefined;
      void remove(view).catch(error => ctx.ui.notify(String(error), "error"));
    }
    else if (matchesKey(data, "enter")) {
      const view = views[selected]; selected = undefined;
      void open(view).catch(error => ctx.ui.notify(String(error), "error"));
    } else { selected = undefined; refresh(); return; }
    refresh(); return { consume: true };
  });
  return { refresh, close: () => { unsubscribe(); ctx.ui.setWidget("tmux-subagents", undefined); } };
}
