import { afterAll, afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagent.js";

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
});
const dirs: string[] = [];
function harness() {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void> | void>();
  let tool: ToolDefinition<any> | undefined;
  const sendMessage = vi.fn();
  const pi = {
    on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (value: ToolDefinition<any>) => { tool = value; },
    sendMessage,
  } as unknown as ExtensionAPI;
  extension(pi);
  const dir = mkdtempSync(join(tmpdir(), "subagent-test-"));
  dirs.push(dir);
  let sessionId = "original";
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionId: () => sessionId, buildContextEntries: () => [] },
    shutdown: vi.fn(),
  } as unknown as ExtensionContext;
  return {
    handlers, sendMessage, ctx, dir,
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
  const a = first.details as { session: string; windowId: string };
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
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`-t ${a.windowId}`) });
    const option = (id: string, name: string) => execFileSync("tmux", ["show-options", "-w", "-t", id, name], { encoding: "utf8" }).trim();
    expect(option(a.windowId, "remain-on-exit")).toBe("remain-on-exit on");
    expect(option(a.windowId, "automatic-rename")).toBe("automatic-rename off");
    execFileSync("tmux", ["kill-window", "-t", a.windowId]);
    expect(windowName(b.windowId)).toBe("project-b｜检查任务队列");
    execFileSync("tmux", ["kill-window", "-t", b.windowId]);
    const replacement = await h.execute({ task: "read docs", title: "project-c｜阅读文档", piArgs: [] });
    const c = replacement.details as typeof a;
    expect(c.session).toBe(a.session);
    expect(c.windowId).not.toBe(b.windowId);
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
  const { readFileSync } = await import("node:fs");
  const env = (windowId: string, key: string) => {
    const pid = execFileSync("tmux", ["display-message", "-p", "-t", windowId, "#{pane_pid}"], { encoding: "utf8" }).trim();
    const entry = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((part) => part.startsWith(`${key}=`));
    return entry!.slice(key.length + 1);
  };
  const socket = env(a.windowId, "PI_SUBAGENT_SOCKET");
  const tokenA = env(a.windowId, "PI_SUBAGENT_TOKEN");
  const tokenB = env(b.windowId, "PI_SUBAGENT_TOKEN");
  expect(a.id).not.toBe(b.id);
  const report = (body: object) => new Promise<void>((resolve, reject) => {
    const s = connect(socket);
    s.on("error", reject);
    s.on("close", () => resolve());
    s.on("connect", () => s.end(JSON.stringify(body) + "\n"));
  });
  await report({ id: a.id, token: "wrong", text: "no" });
  await report({ id: b.id, token: tokenB, text: "second" });
  await report({ id: a.id, token: tokenA, text: "first" });
  expect(h.sendMessage.mock.calls.map(([msg]) => msg.content)).toEqual([expect.stringContaining("second"), expect.stringContaining("first")]);
  expect(h.sendMessage.mock.calls.every(([, options]) => options.triggerTurn && options.deliverAs === "followUp")).toBe(true);
  const pending = await h.execute({ task: "Answer 3", title: "project｜回答三", piArgs: [] });
  const c = pending.details as typeof a;
  const tokenC = env(c.windowId, "PI_SUBAGENT_TOKEN");
  h.setSession("another");
  await report({ id: c.id, token: tokenC, text: "must not be delivered" });
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
  execFileSync("tmux", ["kill-session", "-t", a.session]);
});
