import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagent.js";

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
  for (const flag of ["--export", "--list-models", "--help", "--version", "--mode=json"]) {
    await expect(h.execute({ task: "hi", piArgs: [flag] })).rejects.toThrow(/interactive/);
  }
  await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("delivers separate results only to the original session and ignores invalid messages", async () => {
  const h = harness();
  // A launched task returns the socket coordinates through its tool details for observation.
  const first = await h.execute({ task: "Answer 1", piArgs: [] });
  const second = await h.execute({ task: "Answer 2", piArgs: [] });
  const a = first.details as { id: string; session: string };
  const b = second.details as typeof a;
  const { execFileSync } = await import("node:child_process");
  const env = (session: string, key: string) => execFileSync("tmux", ["show-environment", "-t", session, key], { encoding: "utf8" }).trim().slice(key.length + 1);
  const socket = env(a.session, "PI_SUBAGENT_SOCKET");
  const tokenA = env(a.session, "PI_SUBAGENT_TOKEN");
  const tokenB = env(b.session, "PI_SUBAGENT_TOKEN");
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
  const pending = await h.execute({ task: "Answer 3", piArgs: [] });
  const c = pending.details as typeof a;
  const tokenC = env(c.session, "PI_SUBAGENT_TOKEN");
  h.setSession("another");
  await report({ id: c.id, token: tokenC, text: "must not be delivered" });
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
  for (const session of [a.session, b.session, c.session]) execFileSync("tmux", ["kill-session", "-t", session]);
});
