import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagent.js";

const names = ["PI_SUBAGENT_ID", "PI_SUBAGENT_TOKEN", "PI_SUBAGENT_SOCKET"] as const;
afterEach(() => { for (const name of names) delete process.env[name]; });

test.each([
  ["stop", "done", "done"],
  ["error", "ignored", "子任务失败"],
  ["aborted", "ignored", "子任务已中断"],
])("reports %s once then exits", async (stopReason, answer, expected) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-report-test-"));
  const socketPath = join(dir, "result.sock");
  const received: string[] = [];
  const server = createServer((socket) => {
    let body = "";
    socket.on("data", (part) => body += part.toString());
    socket.on("end", () => received.push(body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.PI_SUBAGENT_ID = "task-id";
  process.env.PI_SUBAGENT_TOKEN = "secret";
  process.env.PI_SUBAGENT_SOCKET = socketPath;
  let settled: ((event: any, ctx: ExtensionContext) => Promise<void>) | undefined;
  const registerTool = vi.fn();
  extension({ on: (_name: string, cb: typeof settled) => { settled = cb; return () => {}; }, registerTool } as unknown as ExtensionAPI);
  const shutdown = vi.fn();
  const ctx = { shutdown, sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text: answer }] } }] } } as unknown as ExtensionContext;
  try {
    await settled!({ type: "agent_settled" }, ctx);
    await settled!({ type: "agent_settled" }, ctx);
    expect(registerTool).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toEqual({ id: "task-id", token: "secret", text: expect.stringContaining(expected) });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
