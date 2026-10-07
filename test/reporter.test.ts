import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagent.js";
import { TaskStore } from "../src/task-store.js";
import { request } from "../src/channel.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); for (const key of ["PI_SUBAGENT_ID", "PI_SUBAGENT_TOKEN", "PI_SUBAGENT_ROOT"]) delete process.env[key]; });
async function child() {
  const previousPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = previousPane ?? "%99";
  cleanups.push(() => { if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane; });
  const dir = mkdtempSync(join(tmpdir(), "pi-child-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const owner = "parent";
  mkdirSync(join(dir, owner), { recursive: true });
  const record = { id: "task-id", token: "secret", owner, title: "project｜work", task: "initial task", cwd: dir, piArgs: [], mode: "delegated", round: "round-1", createdAt: Date.now(), windowId: "@1", paneId: "%1", tmuxSocket: "/test/socket" };
  writeFileSync(join(dir, owner, "task-id.json"), JSON.stringify(record));
  const path = join(dir, "parent.sock");
  const received: any[] = [];
  const server = createServer(s => { let body = ""; s.on("data", b => { body += b; if (body.includes("\n")) { received.push(JSON.parse(body)); s.end(JSON.stringify({ ok: true }) + "\n"); } }); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(() => { server.close(); });
  writeFileSync(join(dir, owner, "endpoint.json"), JSON.stringify({ socket: path }));
  process.env.PI_SUBAGENT_ID = "task-id";
  process.env.PI_SUBAGENT_TOKEN = "secret";
  process.env.PI_SUBAGENT_ROOT = dir;
  process.env.PI_SUBAGENT_OWNER = owner;
  cleanups.push(() => { delete process.env.PI_SUBAGENT_OWNER; });
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let raw: any;
  let answer = "done";
  let editorText = "";
  let sessionId = "child-session";
  const shutdown = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const ctx = { mode: "tui", cwd: dir, hasUI: true, isIdle: () => true, shutdown, ui: { getEditorText: () => editorText, setWidget: (_key: string, factory: any) => { if (factory) factory({ getFocusedComponent: () => ({ getText: () => editorText }), hasOverlay: () => false, requestRender: vi.fn() }, { fg: (_color: string, text: string) => text }); }, onTerminalInput: (fn: any) => { raw = fn; return () => {}; }, notify, confirm }, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(dir, "child.jsonl"), buildContextEntries: () => [{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] } }] } } as unknown as ExtensionContext;
  const api = { on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; }, registerTool: (tool: any) => tools.set(tool.name, tool), sendUserMessage: vi.fn(), registerCommand: (name: string, value: any) => commands.set(name, value) } as unknown as ExtensionAPI;
  extension(api);
  await handlers.get("session_start")?.({}, ctx);
  cleanups.push(() => { void handlers.get("session_shutdown")?.({}, ctx); });
  return { reload: async () => { await handlers.get("session_shutdown")({ reason: "reload" }, ctx); extension(api); await handlers.get("session_start")({ reason: "reload" }, ctx); }, handlers, tools, commands, ctx, shutdown, received, notify, confirm, store: new TaskStore(dir, owner), parent: server, setSession: (id: string) => { sessionId = id; }, inputText: (text: string) => { editorText = text; }, raw: (data: string) => raw(data), answer: (text: string) => { answer = text; } };
}

test("a delegated result is acknowledged once and leaves interactive Pi alive", async () => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.shutdown).not.toHaveBeenCalled();
  expect(h.received).toHaveLength(1);
  expect(h.received[0]).toMatchObject({ id: "task-id", text: "done", round: "round-1" });
});

test("Esc takes over before settlement, passes through to Pi, and silences interrupted and later rounds", async () => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  expect(h.raw("\x1b")).toBeUndefined();
  await h.handlers.get("agent_settled")({}, h.ctx);
  await h.handlers.get("input")({ text: "more context", source: "interactive" }, h.ctx);
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.received).toHaveLength(0);
  expect(h.shutdown).not.toHaveBeenCalled();
});

test("direct input also silences an unsent delegated round without Esc", async () => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("input")({ text: "more context", source: "interactive" }, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.received).toHaveLength(0);
});

test("explicit reporting requires approval and reports only the chosen summary", async () => {
  const h = await child();
  h.raw("\x1b");
  const tool = h.tools.get("subagent_report");
  expect(tool).toBeDefined();
  h.confirm.mockResolvedValueOnce(false);
  await expect(tool.execute("call", { text: "chosen summary" }, undefined, undefined, h.ctx)).rejects.toThrow(/cancel|取消/);
  expect(h.received).toHaveLength(0);
  await tool.execute("call", { text: "chosen summary" }, undefined, undefined, h.ctx);
  expect(h.received).toHaveLength(1);
  expect(h.received[0]).toMatchObject({ text: "chosen summary", explicit: true });
});

test("editor submission cancels reporting before SDK's deferred input event", async () => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  h.inputText("additional facts");
  expect(h.raw("\r")).toBeUndefined();
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.received).toHaveLength(0);
});

test("boot-time delegation is rejected, and user collaboration needs explicit handoff", async () => {
  const h = await child();
  const socket = h.store.state("task-id")!.controlSocket!;
  const delegate = async () => {
    const ready = await request(socket, { kind: "prepare-delegate", id: "task-id", owner: "parent", token: "secret", round: "next" });
    if (!ready.ok) return ready;
    return request(socket, { kind: "delegate", id: "task-id", owner: "parent", token: "secret", expectedRound: ready.state!.round, round: "next", task: "next task" });
  };
  expect(await delegate()).toMatchObject({ ok: false });
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  h.raw("\x1b");
  expect(await delegate()).toMatchObject({ ok: false });
  await h.commands.get("subagent-handoff").handler("", h.ctx);
  expect(await delegate()).toEqual({ ok: true });
  expect(h.store.state("task-id")).toMatchObject({ mode: "delegated", reportPending: true, round: "next" });
});

test("leaving the registered child session cannot migrate identity or broadcast unrelated history", async () => {
  const h = await child();
  h.setSession("unrelated-session");
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.store.state("task-id")).toMatchObject({ sessionId: "child-session", mode: "user", handoff: false });
  expect(h.received).toHaveLength(0);
});

test("a disconnected parent is reported as unsent, with no automatic replay on later settlement", async () => {
  const h = await child();
  await new Promise<void>(resolve => h.parent.close(() => resolve()));
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.store.state("task-id")).toMatchObject({ delivery: "unsent", lastText: "done", reportPending: false });
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.received).toHaveLength(0);
  expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Not delivered"), "error");
});

test("real event telemetry tracks turns, tools, tokens, activity and frozen round duration", async () => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("turn_start")({}, h.ctx);
  await h.handlers.get("tool_execution_start")({ toolCallId: "edit-1", toolName: "edit", args: { path: "a.ts" } }, h.ctx);
  await h.handlers.get("tool_execution_start")({ toolCallId: "edit-2", toolName: "edit", args: { path: "b.ts" } }, h.ctx);
  expect(h.store.state("task-id")).toMatchObject({ turns: 1, toolUses: 2, activity: "Editing 2 files…" });
  await h.handlers.get("message_end")({ message: { role: "assistant", usage: { totalTokens: 1234 } } }, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.store.state("task-id")).toMatchObject({ tokens: 1234, endedAt: expect.any(Number) });
  expect(h.store.state("task-id")?.activity).toBeUndefined();
});

test("remove request requires confirmation when busy and silences automatic interruption reports", async () => {
  const h = await child();
  const abort = vi.fn();
  Object.assign(h.ctx, { abort });
  await h.handlers.get("agent_start")({}, h.ctx);
  const socket = h.store.state("task-id")!.controlSocket!;
  const stop = (confirmInterrupt: boolean) => request(socket, { kind: "remove", id: "task-id", owner: "parent", token: "secret", confirmInterrupt });
  expect(await stop(false)).toMatchObject({ ok: false, needsConfirmation: true });
  expect(abort).not.toHaveBeenCalled();
  expect(await stop(true)).toEqual({ ok: true });
  expect(abort).toHaveBeenCalledTimes(1);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.received).toHaveLength(0);
  await new Promise(r => setTimeout(r, 50));
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

test.each(["\x1b[D", "\x1b[B"])("idle child %j returns to main without takeover, but never intercepts drafts or dialogs", async key => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  expect(h.raw(key)).toBeUndefined();
  await h.handlers.get("agent_settled")({}, h.ctx);
  h.inputText("draft");
  expect(h.raw(key)).toBeUndefined();
  h.inputText("");
  await h.handlers.get("ui_prompt_start")({}, h.ctx);
  expect(h.raw(key)).toBeUndefined();
  await h.handlers.get("ui_prompt_end")({}, h.ctx);
  expect(h.raw(key)).toEqual({ consume: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.received.some(message => message.kind === "locate-main")).toBe(true);
  expect(h.store.state("task-id")?.mode).toBe("delegated");
  expect(h.shutdown).not.toHaveBeenCalled();
});

test("idle reload preserves delegation ownership and enables arrow return without another model turn", async () => {
  const h = await child();
  await h.handlers.get("agent_start")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  await h.reload();
  expect(h.store.state("task-id")).toMatchObject({ mode: "delegated", handoff: true, reportPending: false, status: "waiting" });
  expect(h.raw("\x1b[D")).toEqual({ consume: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.received.filter(message => message.kind === "result")).toHaveLength(1);
  expect(h.received.some(message => message.kind === "locate-main")).toBe(true);
});
