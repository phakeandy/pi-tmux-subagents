import { expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagent.js";
import { TaskStore, ownerKey } from "../src/task-store.js";
const exec = promisify(execFile);

// Opt-in: uses real Pi/model credentials, creates and destroys ONLY its isolated tmux server.
test.skipIf(process.env.PI_SUBAGENT_LIVE_TEST !== "1")("real Pi reports, stays alive, hands over, redelegates and restores its exact session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-live-"));
  const socket = join(dir, "tmux.sock");
  const oldTmux = process.env.TMUX; const oldRoot = process.env.PI_SUBAGENT_ROOT;
  process.env.TMUX = `${socket},0,0`; process.env.PI_SUBAGENT_ROOT = join(dir, "records");
  const handlers = new Map<string, any>();
  let tool: ToolDefinition<any>;
  const sendMessage = vi.fn();
  const commands = new Map<string, any>();
  const ctx = { cwd: resolve("."), hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => "live-original", getSessionFile: () => undefined } } as unknown as ExtensionContext;
  const pi = { on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; }, registerTool: (t: ToolDefinition<any>) => { tool = t; }, registerCommand: (name: string, command: any) => commands.set(name, command), registerMessageRenderer: vi.fn(), appendEntry: vi.fn(), sendMessage } as unknown as ExtensionAPI;
  extension(pi);
  const execute = (params: any) => tool.execute("live", params, new AbortController().signal, () => {}, ctx);
  const tmux = (args: string[]) => exec("tmux", ["-S", socket, ...args]);
  async function waitFor(check: () => boolean, label: string, timeout = 60000) {
    const start = Date.now();
    while (!check()) { if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`); await new Promise(r => setTimeout(r, 250)); }
  }
  let pane = "";
  try {
    const started = await execute({ title: "live-test｜会话生命周期", task: "Reply with exactly SMOKE_OK. Do not call any tools.", piArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline", "--thinking", "low", "--session-dir", join(dir, "sessions")] });
    const id = (started.details as { id: string }).id;
    pane = (started.details as { paneId: string }).paneId;
    const store = new TaskStore(process.env.PI_SUBAGENT_ROOT!, ownerKey("live-original"));
    await waitFor(() => sendMessage.mock.calls.length === 1, "initial automatic report");
    await waitFor(() => store.state(id)?.delivery === "sent", "report acknowledgement");
    expect(store.state(id)?.status).toBe("waiting");
    expect(store.state(id)?.tokens).toBeGreaterThan(0);
    expect(store.state(id)?.turns).toBeGreaterThanOrEqual(1);
    expect(store.state(id)?.endedAt).toBeGreaterThanOrEqual(store.state(id)!.startedAt!);
    expect((await tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"])).stdout.trim()).toBe("0");
    const originalFile = store.state(id)!.sessionFile;
    await tmux(["send-keys", "-t", pane, "Escape"]);
    await waitFor(() => store.state(id)?.mode === "user", "Esc takeover");
    await tmux(["send-keys", "-l", "-t", pane, "Reply with exactly USER_FOLLOWUP. Do not call tools."]);
    await tmux(["send-keys", "-t", pane, "Enter"]);
    await waitFor(() => store.state(id)?.lastText?.includes("USER_FOLLOWUP") === true, "direct followup");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await tmux(["send-keys", "-l", "-t", pane, "/subagent-report EXPLICIT_SUMMARY"]);
    await tmux(["send-keys", "-t", pane, "Enter"]);
    await waitFor(() => sendMessage.mock.calls.length === 2, "explicit summary");
    expect(sendMessage.mock.calls[1][0].content).toContain("EXPLICIT_SUMMARY");
    await expect(execute({ action: "followup", id, task: "unauthorized" })).rejects.toThrow(/handoff/);
    await tmux(["send-keys", "-l", "-t", pane, "/subagent-handoff"]);
    await tmux(["send-keys", "-t", pane, "Enter"]);
    await waitFor(() => store.state(id)?.handoff === true, "explicit handoff");
    // Restart the parent extension on the same original identity, without replaying results.
    await handlers.get("session_shutdown")({}, ctx);
    extension(pi);
    await handlers.get("session_start")({}, ctx);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await execute({ action: "followup", id, task: "Reply with exactly DELEGATED_AGAIN. Do not call tools." });
    await waitFor(() => sendMessage.mock.calls.length === 3, "redelegated automatic report");
    await waitFor(() => store.state(id)?.delivery === "sent", "second acknowledgement");
    await execute({ action: "followup", id, task: "Use bash to run sleep 15, then reply LONG_DELEGATION_DONE. Do not modify files." });
    await waitFor(() => store.state(id)?.status === "running" && (store.state(id)?.toolUses ?? 0) > 0, "real running tool before Esc");
    await tmux(["send-keys", "-t", pane, "Escape"]);
    await waitFor(() => store.state(id)?.mode === "user" && store.state(id)?.status !== "running", "busy Esc interruption");
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await tmux(["send-keys", "-t", pane, "C-d"]);
    await waitFor(() => store.state(id)?.status === "exited", "clean child exit");
    await new Promise(r => setTimeout(r, 500));
    const restored = await execute({ action: "restore", id });
    expect((restored.details as { paneId: string }).paneId).toBe(pane);
    await waitFor(() => store.state(id)?.status === "waiting" && !!store.state(id)?.controlSocket, "exact session restore");
    expect(store.state(id)?.sessionFile).toBe(originalFile);
    expect(store.state(id)?.mode).toBe("user");
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await commands.get("subagent-remove").handler(id, ctx);
    expect(store.get(id)?.removedAt).toBeTypeOf("number");
    expect(store.list().some(r => r.id === id)).toBe(false);
    expect(existsSync(originalFile!)).toBe(true);
  } catch (error) {
    if (pane) console.error((await tmux(["capture-pane", "-p", "-S", "-100", "-t", pane]).catch(() => ({ stdout: "pane unavailable" }))).stdout);
    throw error;
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await tmux(["kill-server"]).catch(() => {});
    if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
    if (oldRoot === undefined) delete process.env.PI_SUBAGENT_ROOT; else process.env.PI_SUBAGENT_ROOT = oldRoot;
    rmSync(dir, { recursive: true, force: true });
  }
}, 240000);
