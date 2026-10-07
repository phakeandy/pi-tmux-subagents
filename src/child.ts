import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { TaskStore, storageRoot, type ChildState } from "./task-store.js";
import { request, serve } from "./channel.js";
import { returnToMain } from "./return-to-main.js";

export function finalAnswer(ctx: ExtensionContext): { text: string; failed: boolean } {
  const last = ctx.sessionManager.buildContextEntries().reverse().find(e => e.type === "message" && e.message.role === "assistant");
  if (!last || last.type !== "message" || last.message.role !== "assistant") return { text: "Subagent failed: no final answer for this round.", failed: true };
  const message = last.message;
  if (message.stopReason === "error") return { text: `Subagent failed: ${message.errorMessage ?? "Model request failed"}`, failed: true };
  if (message.stopReason === "aborted") return { text: "Subagent interrupted.", failed: true };
  return { text: message.content.filter(p => p.type === "text").map(p => p.text).join("\n"), failed: false };
}
export function childExtension(pi: ExtensionAPI): void {
  const id = process.env.PI_SUBAGENT_ID!;
  const owner = process.env.PI_SUBAGENT_OWNER!;
  const token = process.env.PI_SUBAGENT_TOKEN!;
  const restored = process.env.PI_SUBAGENT_RESTORE === "1";
  const store = new TaskStore(storageRoot(), owner);
  const record = store.get(id);
  if (!record || record.token !== token) throw new Error("Subagent registration is missing or invalid");
  let ctx: ExtensionContext;
  let state: ChildState;
  let control: Awaited<ReturnType<typeof serve>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let firstInput = !restored;
  let promptDepth = 0;
  let reportInFlight = false;
  let returning = false;
  let terminal: TUI | undefined;
  let bound = false;
  let booting = !restored;
  let baselineAssistant: string | undefined;
  let prepared: { round: string; expiresAt: number } | undefined;
  const tools = new Map<string, { name: string; path?: string }>();
  function contextUsage() {
    const usage = ctx.getContextUsage?.();
    state.contextPercent = typeof usage?.percent === "number" ? usage.percent : undefined;
  }
  function activity(fallback = "Thinking…") {
    const names = [...tools.values()];
    const files = new Set(names.filter(t => t.name === "edit" || t.name === "write").map(t => t.path).filter(Boolean));
    if (files.size) return `Editing ${files.size} file${files.size === 1 ? "" : "s"}…`;
    if (names.some(t => t.name === "read")) return "Reading files…";
    if (names.some(t => ["grep", "find", "ls", "web_search"].includes(t.name))) return "Searching…";
    if (names.length) return `Running ${names[0].name}${names.length > 1 ? ` and ${names.length - 1} other tools` : ""}…`;
    return fallback;
  }
  const publish = () => { state.updatedAt = Date.now(); store.saveState(id, state); terminal?.requestRender(); };
  const isBound = () => bound && ctx.sessionManager.getSessionId() === state.sessionId;
  const requireBound = () => { if (!isBound()) throw new Error("This Pi left the registered child session; resume the original session before reporting or delegating"); };
  const takeover = () => { prepared = undefined; state.mode = "user"; state.reportPending = false; state.handoff = false; publish(); };
  const notify = (text: string, type: "info" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(text, type); };
  async function goMain(current: ExtensionContext): Promise<void> {
    if (returning) return;
    returning = true;
    try {
      const endpoint = store.endpoint();
      if (!endpoint || !process.env.TMUX_PANE) throw new Error("The original main session is offline, or this Pi is not in tmux.");
      const reply = await request(endpoint.socket, { kind: "locate-main", id, token, owner });
      if (!reply.ok || !reply.main) throw new Error(reply.error ?? "Cannot locate the original main session.");
      await returnToMain(reply.main, owner, process.env.TMUX_PANE);
    } catch (error) { current.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { returning = false; }
  }
  async function report(text: string, explicit: boolean, round: string): Promise<void> {
    requireBound();
    if (reportInFlight) throw new Error("A report is already in progress");
    reportInFlight = true;
    try {
      const endpoint = store.endpoint();
      if (!endpoint) throw new Error("Original main session is offline");
      const reply = await request(endpoint.socket, { kind: "result", id, token, owner, round, explicit, text });
      if (!reply.ok) throw new Error(reply.error ?? "Report rejected");
      state.delivery = "sent"; state.unsentText = undefined; state.error = undefined; publish();
      notify("Delivered to the original main session");
    } catch (error) {
      state.delivery = "unsent"; state.unsentText = text; state.error = error instanceof Error ? error.message : String(error); publish();
      notify(`Not delivered: ${state.error}. Use /subagent-report to resend manually.`, "error");
      throw error;
    } finally { reportInFlight = false; }
  }
  pi.on("session_start", async (_event, current) => {
    ctx = current;
    unsubscribe?.(); control?.close();
    const old = store.state(id);
    const sameSession = old?.sessionId === ctx.sessionManager.getSessionId();
    booting = !sameSession && !restored;
    firstInput = booting;
    if (old?.sessionId && !sameSession) {
      bound = false; state = { ...old, activeSessionId: ctx.sessionManager.getSessionId(), mode: "user", status: "error", error: "The original child session is no longer active; resume it first.", reportPending: false, handoff: false, controlSocket: undefined };
      publish();
      return;
    }
    bound = true;
    state = sameSession ? { ...old!, ...(restored ? { mode: "user" as const, reportPending: false, handoff: false } : {}) } : {
      mode: restored ? "user" : record.mode, round: record.round, status: "waiting",
      reportPending: !restored && record.mode === "delegated", handoff: !restored && record.mode === "delegated", updatedAt: Date.now(),
    };
    state.sessionId = ctx.sessionManager.getSessionId(); state.activeSessionId = state.sessionId; state.sessionFile = ctx.sessionManager.getSessionFile(); state.pid = process.pid;
    state.status = ctx.isIdle() ? "waiting" : "running";
    if (state.startedAt && !state.endedAt && old?.status !== "running") {
      const last = ctx.sessionManager.buildContextEntries().filter(e => e.type === "message" && e.message.role === "assistant").at(-1);
      const time = last ? Date.parse(last.timestamp) : NaN;
      if (Number.isFinite(time) && time >= state.startedAt) state.endedAt = time;
    }
    contextUsage();
    control = await serve(async message => {
      if (message.id !== id || message.token !== token || message.owner !== owner) return { ok: false, error: "Invalid task credentials" };
      if (message.kind === "status") return { ok: true, state: { round: state.round, activeSessionId: ctx.sessionManager.getSessionId() } };
      if (message.kind === "prepare-delegate") {
        if (!isBound() || booting || !ctx.isIdle() || state.status === "running" || state.reportPending || reportInFlight || !state.handoff) return { ok: false, error: "The child is busy or has not been handed back; cannot prepare another delegation." };
        if (typeof message.round !== "string") return { ok: false, error: "Invalid round" };
        if (prepared && prepared.expiresAt > Date.now() && prepared.round !== message.round) return { ok: false, error: "Another delegation is being prepared" };
        prepared = { round: message.round, expiresAt: Date.now() + 5000 };
        return { ok: true, state: { round: state.round, activeSessionId: state.sessionId } };
      }
      if (message.kind === "remove") {
        if (!isBound()) return { ok: false, error: "The original child session is no longer active; refusing to close an unrelated session." };
        if ((!ctx.isIdle() || state.status === "running" || booting) && !message.confirmInterrupt) return { ok: false, needsConfirmation: true, error: "The child is still running; interruption requires confirmation." };
        takeover();
        ctx.abort();
        // Let the acknowledgement leave the socket before orderly Pi shutdown.
        const operation = ctx;
        const expectedSession = state.sessionId;
        const shutdown = setTimeout(() => { if (operation.sessionManager.getSessionId() === expectedSession) operation.shutdown(); }, 30); shutdown.unref();
        return { ok: true };
      }
      if (message.kind !== "delegate" || typeof message.task !== "string" || !message.task.trim() || typeof message.round !== "string") return { ok: false, error: "Invalid delegation" };
      if (!isBound()) return { ok: false, error: "Original child session is no longer active" };
      if (booting || !ctx.isIdle() || state.status === "running" || state.reportPending || reportInFlight) return { ok: false, error: "Subagent is busy; do not interrupt user collaboration" };
      if (!state.handoff) return { ok: false, error: "Please run /subagent-handoff in the child session first." };
      if (!prepared || prepared.round !== message.round || prepared.expiresAt < Date.now() || message.expectedRound !== state.round) return { ok: false, error: "Delegation was not prepared or its round changed" };
      prepared = undefined;
      state.mode = "delegated"; state.round = message.round; state.reportPending = true; state.error = undefined; state.delivery = undefined; publish();
      pi.sendUserMessage(message.task);
      return { ok: true };
    });
    state.controlSocket = control.path; publish();
    if (ctx.mode === "tui" && ctx.hasUI) {
      ctx.ui.setWidget("tmux-subagent-collaboration", (tui, theme) => {
        terminal = tui;
        return { render: (width: number) => [truncateToWidth((ctx.ui.theme ?? theme).fg("muted", `Subagent · ${state.mode === "user" ? "User collaboration · auto-report off" : "Main-agent delegation"}${state.handoff ? " · Delegation enabled" : ""} · /main`), width)], invalidate: () => {} };
      });
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (!isBound() || promptDepth) return;
        // Cancel at submission time too: SDK may defer the input event until settlement ends.
        const focus = (terminal as (TUI & { getFocusedComponent?: () => unknown }) | undefined)?.getFocusedComponent?.() as { getText?: () => string } | undefined;
        const text = focus?.getText?.() ?? "";
        if (!booting && ctx.isIdle() && state.status !== "running" && !reportInFlight && focus?.getText && text === "" && ctx.ui.getEditorText() === "" && !terminal?.hasOverlay() && (matchesKey(data, "left") || matchesKey(data, "down"))) {
          void goMain(ctx);
          return { consume: true };
        }
        const submission = !terminal?.hasOverlay() && text.trim() && !text.startsWith("/") && (matchesKey(data, "enter") || matchesKey(data, "alt+enter"));
        if (matchesKey(data, "escape") || submission) takeover();
        return undefined; // Pi must still process abort or submission normally.
      });
    }
  });
  pi.on("ui_prompt_start", () => { promptDepth++; });
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
  pi.on("input", event => {
    if (!isBound()) return;
    // Pi presents a CLI initial prompt as interactive input too.
    if (firstInput && event.text === record.task) { firstInput = false; return; }
    firstInput = false;
    if (event.source === "interactive") takeover();
  });
  pi.on("agent_start", () => {
    if (!isBound()) return;
    firstInput = false; state.status = "running"; state.startedAt = Date.now(); state.endedAt = undefined; state.error = undefined;
    state.turns = 0; state.toolUses = 0; state.tokens = 0; state.activity = "Thinking…"; tools.clear();
    baselineAssistant = ctx.sessionManager.buildContextEntries().filter(e => e.type === "message" && e.message.role === "assistant").at(-1)?.id;
    publish();
  });
  pi.on("agent_settled", async (_event, current) => {
    ctx = current;
    if (!isBound()) return;
    booting = false;
    let answer = finalAnswer(ctx);
    const lastAssistant = ctx.sessionManager.buildContextEntries().filter(e => e.type === "message" && e.message.role === "assistant").at(-1);
    if (baselineAssistant && lastAssistant?.id === baselineAssistant) answer = { text: "Subagent failed: no new final answer for this round.", failed: true };
    state.status = answer.failed ? "error" : "waiting"; state.lastText = answer.text; state.endedAt = Date.now(); state.activity = undefined; tools.clear(); contextUsage();
    const shouldReport = state.reportPending && state.mode === "delegated";
    state.reportPending = false; publish();
    if (shouldReport) { try { await report(answer.text, false, state.round); } catch { /* No automatic offline replay. */ } }
    // A settled round is not project acceptance and must not exit Pi.
  });
  pi.on("turn_start", () => {
    if (!isBound()) return;
    state.turns = (state.turns ?? 0) + 1; publish();
  });
  pi.on("tool_execution_start", event => {
    if (!isBound()) return;
    if (!tools.has(event.toolCallId)) state.toolUses = (state.toolUses ?? 0) + 1;
    tools.set(event.toolCallId, { name: event.toolName, path: typeof event.args?.path === "string" ? event.args.path : undefined });
    state.activity = activity(); publish();
  });
  pi.on("tool_execution_end", event => {
    if (!isBound()) return;
    tools.delete(event.toolCallId); state.activity = activity(event.isError ? "Tool failed; handling error…" : "Thinking…"); publish();
  });
  pi.on("message_update", event => {
    if (!isBound() || state.status !== "running") return;
    const type = event.assistantMessageEvent.type;
    const next = activity(type.startsWith("text_") ? "Responding…" : "Thinking…");
    if (state.activity !== next) { state.activity = next; publish(); }
  });
  pi.on("message_end", (event, current) => {
    if (!isBound() || event.message.role !== "assistant" || state.status !== "running") return;
    ctx = current;
    state.tokens = (state.tokens ?? 0) + event.message.usage.totalTokens;
    contextUsage(); publish();
  });
  pi.registerCommand("main", {
    description: "Return to the original online main Agent's tmux pane without interrupting this task",
    handler: async (_args, current) => { await goMain(current); },
  });
  pi.registerCommand("subagent-handoff", {
    description: "Explicitly allow the original main Agent to delegate another round to this session",
    handler: async (_args, current) => {
      requireBound();
      if (booting || !current.isIdle() || state.status === "running") { current.ui.notify("Press Esc to stop the current run before handing back.", "warning"); return; }
      state.handoff = true; publish();
      current.ui.notify("Delegation enabled for the original main Agent. New delegated rounds will report automatically. No report was sent.", "info");
    },
  });
  pi.registerCommand("subagent-report", {
    description: "Explicitly send supplied text or the last summary to the original main session",
    handler: async (args, current) => {
      ctx = current;
      const text = args.trim() || state.unsentText || state.lastText;
      if (!text) { current.ui.notify("No summary available. Use /subagent-report <summary>.", "warning"); return; }
      try { await report(text, true, randomUUID()); } catch { /* report already displays the delivery failure. */ }
    },
  });
  pi.registerTool({
    name: "subagent_report", label: "Report to original main Agent",
    description: "Send a summary to the original main session ONLY when the user explicitly requests it. A user confirmation is required on every call. This does not hand control back or imply project acceptance.",
    parameters: Type.Object({ text: Type.String({ description: "The exact summary the user asked to send" }) }),
    async execute(_call, params, _signal, _update, current) {
      ctx = current;
      if (!ctx.hasUI || !await ctx.ui.confirm("Send to the original main Agent?", params.text)) throw new Error("Report cancelled");
      await report(params.text, true, randomUUID());
      return { content: [{ type: "text", text: "Delivery to the original main session confirmed." }], details: { delivered: true } };
    },
  });
  pi.on("session_shutdown", event => {
    unsubscribe?.(); unsubscribe = undefined; control?.close(); control = undefined;
    if (ctx?.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("tmux-subagent-collaboration", undefined);
    if (state && isBound()) {
      state.controlSocket = undefined;
      if (event.reason !== "reload") {
        state.status = "exited";
        if (!state.endedAt && state.startedAt) state.endedAt = Date.now();
        state.reportPending = false; state.handoff = false;
      }
      publish();
    }
  });
}
