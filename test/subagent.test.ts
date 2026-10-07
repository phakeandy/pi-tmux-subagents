import { afterAll, afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagent.js";
import { TaskStore, ownerKey } from "../src/task-store.js";
import { request, serve } from "../src/channel.js";
const previousRoot = process.env.PI_SUBAGENT_ROOT;
const root = mkdtempSync(join(tmpdir(), "subagent-store-"));
process.env.PI_SUBAGENT_ROOT = root;

// Isolate the tmux server: tests must never remove a user's shared session.
const previousTmux = process.env.TMUX;
const previousPath = process.env.PATH;
const bin = mkdtempSync(join(tmpdir(), "subagent-bin-"));
writeFileSync(join(bin, "pi"), "#!/bin/sh\nexec sleep 60\n");
chmodSync(join(bin, "pi"), 0o755);
process.env.PATH = `${bin}:${previousPath}`;
process.env.TMUX = join(tmpdir(), `tmux-${process.getuid!()}`, `subagent-test-${process.pid}-${Date.now()}`) + ",0,0";
afterAll(async () => {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* No server if all calls were rejected. */ }
  if (previousTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = previousTmux;
  process.env.PATH = previousPath;
  rmSync(bin, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.PI_SUBAGENT_ROOT; else process.env.PI_SUBAGENT_ROOT = previousRoot;
});
const dirs: string[] = [];
function harness() {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void> | void>();
  let tool: ToolDefinition<any> | undefined;
  const sendMessage = vi.fn();
  const entries: any[] = [];
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const pi = {
    on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (value: ToolDefinition<any>) => { tool = value; },
    sendMessage,
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  extension(pi);
  const dir = mkdtempSync(join(tmpdir(), "subagent-test-"));
  dirs.push(dir);
  let sessionId = "original";
  const ctx = {
    cwd: dir, hasUI: true, ui: { confirm: vi.fn(async () => true), notify: vi.fn(), select: vi.fn() },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, buildContextEntries: () => [], getBranch: () => entries },
    shutdown: vi.fn(),
  } as unknown as ExtensionContext;
  return {
    handlers, commands, renderers, sendMessage, ctx, dir,
    get tool() { return tool!; },
    setSession: (id: string) => { sessionId = id; },
    execute: (params: object) => tool!.execute("call", params, new AbortController().signal, () => {}, ctx),
  };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("rejects incompatible interactive options before creating a tmux session", async () => {
  const h = harness();
  await expect(h.execute({ task: "hi", piArgs: ["--tui-mode=fullscreen"] })).rejects.toThrow(/regular/);
  await expect(h.execute({ task: "hi", piArgs: ["--print"] })).rejects.toThrow(/interactive/);
  await expect(h.execute({ task: "hi", title: "project｜work", piArgs: ["--name", "other"] })).rejects.toThrow(/interactive/);
  await expect(h.execute({ task: "hi", title: "project｜work", piArgs: ["--name=other"] })).rejects.toThrow(/interactive/);
  await expect(h.execute({ task: "hi", title: "bad\ntitle", piArgs: [] })).rejects.toThrow(/title/);
  await expect(h.execute({ task: "hi", title: "project｜work\n", piArgs: [] })).rejects.toThrow(/title/);
  for (const flag of ["--export", "--list-models", "--help", "--version", "--mode=json"]) {
    await expect(h.execute({ task: "hi", piArgs: [flag] })).rejects.toThrow(/interactive/);
  }
  await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("groups concurrent tasks in one named session with stable window IDs and task titles", async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.execute({ task: "read auth", title: "project-a｜调查认证流程", piArgs: [] }),
    h.execute({ task: "read queue", title: "project-b｜检查任务队列", piArgs: [] }),
  ]);
  const a = first.details as { session: string; windowId: string; paneId: string };
  const b = second.details as typeof a;
  const { execFileSync } = await import("node:child_process");
  try {
    expect(a.session).toBe("pi-tmux-subagents");
    expect(b.session).toBe(a.session);
    expect(a.windowId).toMatch(/^@\d+$/);
    expect(b.windowId).not.toBe(a.windowId);
    const windowName = (id: string) => execFileSync("tmux", ["display-message", "-p", "-t", id, "#{window_name}"], { encoding: "utf8" }).trim();
    expect(windowName(a.windowId)).toBe("project-a｜调查认证流程");
    expect(windowName(b.windowId)).toBe("project-b｜检查任务队列");
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`-t ${a.paneId}`) });
    const option = (id: string, name: string) => execFileSync("tmux", ["show-options", "-w", "-t", id, name], { encoding: "utf8" }).trim();
    expect(option(a.windowId, "remain-on-exit")).toBe("remain-on-exit on");
    expect(option(a.windowId, "automatic-rename")).toBe("automatic-rename off");
    execFileSync("tmux", ["kill-window", "-t", a.windowId]);
    expect(windowName(b.windowId)).toBe("project-b｜检查任务队列");
    execFileSync("tmux", ["kill-window", "-t", b.windowId]);
    const replacement = await h.execute({ task: "read docs", title: "project-c｜阅读文档", piArgs: [] });
    const c = replacement.details as typeof a;
    expect(c.session).toBe(a.session);
    // The isolated server may restart after its last window closes and reuse IDs.
    expect((replacement.details as { id: string }).id).not.toBe((second.details as { id: string }).id);
    expect(windowName(c.windowId)).toBe("project-c｜阅读文档");
  } finally {
    await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
    execFileSync("tmux", ["kill-session", "-t", a.session]);
  }
});

test("delivers separate results only to the original session and ignores invalid messages", async () => {
  const h = harness();
  const first = await h.execute({ task: "Answer 1", title: "project｜回答一", piArgs: [] });
  const second = await h.execute({ task: "Answer 2", title: "project｜回答二", piArgs: [] });
  const a = first.details as { id: string; session: string; windowId: string };
  const b = second.details as typeof a;
  const { execFileSync } = await import("node:child_process");
  const storage = new TaskStore(root, ownerKey("original"));
  const socket = storage.endpoint()!.socket;
  const tokenA = storage.get(a.id)!.token;
  const tokenB = storage.get(b.id)!.token;
  expect(a.id).not.toBe(b.id);
  const report = (body: any) => request(socket, { kind: "result", owner: storage.owner, round: storage.get(body.id)?.round, ...body });
  await report({ id: a.id, token: "wrong", text: "no" });
  await report({ id: b.id, token: tokenB, text: "second" });
  await report({ id: a.id, token: tokenA, text: "first" });
  expect(h.sendMessage.mock.calls.map(([msg]) => msg.content)).toEqual([expect.stringContaining("second"), expect.stringContaining("first")]);
  expect(h.sendMessage.mock.calls.every(([, options]) => options.triggerTurn && options.deliverAs === "followUp")).toBe(true);
  const pending = await h.execute({ task: "Answer 3", title: "project｜回答三", piArgs: [] });
  const c = pending.details as typeof a;
  const tokenC = storage.get(c.id)!.token;
  h.setSession("another");
  await report({ id: c.id, token: tokenC, text: "must not be delivered" });
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
  execFileSync("tmux", ["kill-session", "-t", a.session]);
});

test("same original session restores task identities and acknowledges duplicates without replay", async () => {
  const h = harness();
  const started = await h.execute({ task: "one round", title: "project｜恢复登记", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  const payload = { kind: "result", id, owner: storage.owner, token: record.token, round: record.round, text: "unique report" };
  expect(await request(storage.endpoint()!.socket, payload)).toEqual({ ok: true });
  expect(await request(storage.endpoint()!.socket, payload)).toEqual({ ok: true });
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  const restarted = harness();
  await restarted.handlers.get("session_start")!({}, restarted.ctx);
  expect(storage.get(id)?.paneId).toBe(record.paneId);
  expect(await request(storage.endpoint()!.socket, payload)).toEqual({ ok: true });
  expect(restarted.sendMessage).not.toHaveBeenCalled();
  expect(await request(storage.endpoint()!.socket, { ...payload, round: "stale-round" })).toMatchObject({ ok: false });
  await restarted.handlers.get("session_shutdown")!({}, restarted.ctx);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["kill-session", "-t", record.windowId]);
});

test("automatic results are cancelled on user takeover, while explicit summaries can still be sent", async () => {
  const h = harness();
  const started = await h.execute({ task: "one round", title: "project｜接手回传", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  storage.saveState(id, { mode: "user", status: "waiting", round: record.round, reportPending: false, handoff: false, updatedAt: Date.now() });
  const payload = { kind: "result", id, owner: storage.owner, token: record.token, round: record.round, text: "summary" };
  expect(await request(storage.endpoint()!.socket, payload)).toMatchObject({ ok: false });
  expect(h.sendMessage).not.toHaveBeenCalled();
  expect(await request(storage.endpoint()!.socket, { ...payload, explicit: true, round: "explicit-1" })).toEqual({ ok: true });
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  await expect(h.execute({ action: "followup", id, task: "do not seize" })).rejects.toThrow(/offline|handoff/);
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["kill-session", "-t", record.windowId]);
});

test("ACK confirms original-session acceptance even if automatic model wakeup fails", async () => {
  const h = harness();
  const started = await h.execute({ task: "report", title: "project｜接收日志", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  h.sendMessage.mockImplementationOnce(() => { throw new Error("wake failed"); });
  expect(await request(storage.endpoint()!.socket, { kind: "result", id, token: record.token, owner: record.owner, round: record.round, text: "accepted evidence" })).toEqual({ ok: true });
  const enriched: any = await h.handlers.get("context")!({ messages: [] }, h.ctx);
  expect(enriched.messages).toEqual([expect.objectContaining({ role: "custom", content: expect.stringContaining("accepted evidence") })]);
  const again: any = await h.handlers.get("context")!({ messages: enriched.messages }, h.ctx);
  expect(again.messages).toHaveLength(1);
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["kill-session", "-t", record.windowId]);
});

test("removal confirms interruption, cancellation preserves the pane, and confirmed removal keeps history", async () => {
  const h = harness();
  const started = await h.execute({ task: "work", title: "project｜移除验收", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  const history = join(h.dir, "preserved.jsonl");
  writeFileSync(history, "saved history");
  const { execFileSync } = await import("node:child_process");
  const control = await serve(() => {
    setTimeout(() => execFileSync("tmux", ["send-keys", "-t", record.paneId, "C-c"]), 50);
    return { ok: true };
  });
  storage.saveState(id, { mode: "delegated", status: "running", round: record.round, reportPending: true, handoff: true, updatedAt: Date.now(), sessionFile: history, sessionId: "fixture-child", activeSessionId: "fixture-child", controlSocket: control.path });
  const confirm = h.ctx.ui.confirm as ReturnType<typeof vi.fn>;
  confirm.mockResolvedValueOnce(false);
  await h.commands.get("subagent-remove").handler(id, h.ctx);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Interrupt"), expect.stringContaining("preserved"));
  expect(storage.get(id)?.removedAt).toBeUndefined();
  expect(execFileSync("tmux", ["display-message", "-p", "-t", record.paneId, "#{pane_dead}"], { encoding: "utf8" }).trim()).toBe("0");
  await h.commands.get("subagent-remove").handler(id, h.ctx);
  expect(storage.get(id)?.removedAt).toBeTypeOf("number");
  expect(storage.list().some(r => r.id === id)).toBe(false);
  const { existsSync } = await import("node:fs");
  expect(existsSync(history)).toBe(true);
  control.close();
  await h.handlers.get("session_shutdown")!({}, h.ctx);
});

test("a child session switch during confirmed removal never force-closes that pane", async () => {
  const h = harness();
  const started = await h.execute({ task: "work", title: "project｜移除竞态", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  const state = { mode: "delegated" as const, status: "running" as const, round: record.round, reportPending: true, handoff: true, updatedAt: Date.now(), sessionId: "original-child", activeSessionId: "original-child" };
  const control = await serve(() => { storage.saveState(id, { ...state, activeSessionId: "unrelated-child", status: "error" }); return { ok: true }; });
  storage.saveState(id, { ...state, controlSocket: control.path });
  await h.commands.get("subagent-remove").handler(id, h.ctx);
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched"), "error");
  expect(storage.get(id)?.removedAt).toBeUndefined();
  expect(storage.get(id)?.removing).toBe(false);
  const { execFileSync } = await import("node:child_process");
  expect(execFileSync("tmux", ["display-message", "-p", "-t", record.paneId, "#{pane_dead}"], { encoding: "utf8" }).trim()).toBe("0");
  control.close(); await h.handlers.get("session_shutdown")!({}, h.ctx);
  execFileSync("tmux", ["kill-session", "-t", record.windowId]);
});

test("restarting a parent clears interrupted removal markers without closing or replaying tasks", async () => {
  const h = harness();
  const started = await h.execute({ task: "work", title: "project｜恢复移除标记", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  record.removing = true; storage.save(record);
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  const restarted = harness();
  await restarted.handlers.get("session_start")!({}, restarted.ctx);
  expect(storage.get(id)?.removing).toBe(false);
  expect(storage.get(id)?.removedAt).toBeUndefined();
  expect(restarted.sendMessage).not.toHaveBeenCalled();
  await restarted.handlers.get("session_shutdown")!({}, restarted.ctx);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["kill-session", "-t", record.windowId]);
});

test("removal cannot overwrite a concurrently prepared delegation", async () => {
  const h = harness();
  const started = await h.execute({ task: "work", title: "project｜并发操作", piArgs: [] });
  const id = (started.details as { id: string }).id;
  const storage = new TaskStore(root, ownerKey("original"));
  const record = storage.get(id)!;
  let release!: () => void;
  let preparing!: () => void;
  const begun = new Promise<void>(resolve => { preparing = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const state = { mode: "delegated" as const, status: "waiting" as const, round: record.round, reportPending: false, handoff: true, updatedAt: Date.now(), sessionId: "original-child", activeSessionId: "original-child" };
  const control = await serve(async message => {
    if (message.kind === "prepare-delegate") { preparing(); await pending; return { ok: true, state: { round: state.round, activeSessionId: state.sessionId } }; }
    if (message.kind === "delegate") { storage.saveState(id, { ...state, round: message.round }); return { ok: true }; }
    return { ok: false };
  });
  storage.saveState(id, { ...state, controlSocket: control.path });
  const delegated = h.execute({ action: "followup", id, task: "next round" });
  await begun;
  await h.commands.get("subagent-remove").handler(id, h.ctx);
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("operation on this task"), "error");
  expect(storage.get(id)?.removing).toBeUndefined();
  release(); await delegated;
  expect(storage.get(id)?.round).toBe(storage.state(id)?.round);
  control.close(); await h.handlers.get("session_shutdown")!({}, h.ctx);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["kill-session", "-t", record.windowId]);
});
