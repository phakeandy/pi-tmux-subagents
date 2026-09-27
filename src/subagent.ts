import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, connect, type Server } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const extensionPath = fileURLToPath(import.meta.url);
const groupSession = "pi-tmux-subagents";
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const assistantText = (content: { type: string; text?: string }[]) => content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");

function argsForChild(args: string[]): string[] {
  const valueOptions = new Set(["--model", "--provider", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--session-dir"]);
  const incompatible = new Set(["--print", "-p", "--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork", "--mode", "--export", "--list-models", "--help", "-h", "--version", "-v", "--name", "-n", "--"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (incompatible.has(arg) || [...incompatible].some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))) {
      throw new Error(`${arg} is incompatible with a fresh interactive subagent`);
    }
    if (arg === "--tui-mode") {
      if (args[++i] !== "regular") throw new Error("subagent requires --tui-mode regular");
    } else if (arg.startsWith("--tui-mode=")) {
      if (arg !== "--tui-mode=regular") throw new Error("subagent requires --tui-mode regular");
    } else if (valueOptions.has(arg)) {
      if (++i >= args.length) throw new Error(`${arg} requires a value`);
    } else if (!arg.startsWith("-")) {
      throw new Error(`piArgs must contain options, not a prompt: ${arg}`);
    }
  }
  return args.some((arg) => arg === "--tui-mode" || arg === "--tui-mode=regular") ? args : [...args, "--tui-mode", "regular"];
}

function reportChild(pi: ExtensionAPI) {
  let reported = false;
  pi.on("agent_settled", async (_event, ctx) => {
    if (reported) return;
    reported = true;
    const last = ctx.sessionManager.buildContextEntries().reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    let answer = "子任务失败：没有最终回答。";
    if (last?.type === "message" && last.message.role === "assistant") {
      const message = last.message;
      answer = message.stopReason === "aborted" ? "子任务已中断。" : message.stopReason === "error" ? `子任务失败：${message.errorMessage ?? "模型调用失败"}` : assistantText(message.content);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(process.env.PI_SUBAGENT_SOCKET!);
        socket.setTimeout(3000, () => socket.destroy(new Error("report timeout")));
        socket.on("error", reject);
        socket.on("close", () => resolve());
        socket.on("connect", () => socket.end(JSON.stringify({ id: process.env.PI_SUBAGENT_ID, token: process.env.PI_SUBAGENT_TOKEN, text: answer }) + "\n"));
      });
    } catch { /* Parent may have left; tmux retains the pane. */ }
    ctx.shutdown();
  });
}

export default function subagent(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_ID) {
    reportChild(pi);
    return;
  }

  let server: Server | undefined;
  let socketDir: string | undefined;
  let owner: string | undefined;
  const tasks = new Map<string, string>();
  const close = () => {
    server?.close();
    server = undefined;
    tasks.clear();
    owner = undefined;
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    socketDir = undefined;
  };
  pi.on("session_shutdown", close);

  async function listen(ctx: ExtensionContext) {
    if (server) return;
    owner = ctx.sessionManager.getSessionId();
    socketDir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
    const socketPath = join(socketDir, "reply.sock");
    server = createServer((connection) => {
      let body = "";
      connection.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1024 * 1024) connection.destroy();
      });
      connection.on("end", () => {
        try {
          const { id, token, text: result } = JSON.parse(body);
          if (typeof id !== "string" || typeof result !== "string" || !tasks.has(id) || tasks.get(id) !== token || ctx.sessionManager.getSessionId() !== owner) return;
          tasks.delete(id);
          pi.sendMessage({ customType: "subagent-result", content: `子任务 ${id} 的结果：\n${result}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
        } catch { /* Ignore malformed messages. */ }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => server!.once("error", reject).listen(socketPath, resolve));
    } catch (error) {
      close();
      throw error;
    }
    return socketPath;
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Start an independent interactive Pi in a window of the shared tmux session. Returns immediately; the final answer is delivered later. Supply a short title in the form project name｜specific work, using the task cwd for the project name. State read-only requirements and background in task. No recursive delegation.",
    parameters: Type.Object({
      task: Type.String({ description: "The complete task for the independent Pi" }),
      title: Type.String({ description: "Short project name｜specific work, e.g. my-project｜investigate authentication; no generic labels or newlines" }),
      piArgs: Type.Array(Type.String(), { description: "Pi CLI options (not a shell command)" }),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to this session's cwd" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = argsForChild(params.piArgs);
      const title = params.title.trim();
      if (!title || [...title].length > 80 || /[\x00-\x1f\x7f]/.test(title)) throw new Error("title must be 1–80 characters without control characters");
      const cwd = params.cwd ?? ctx.cwd;
      if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      const socketPath = (await listen(ctx)) ?? join(socketDir!, "reply.sock");
      const id = randomUUID();
      const token = randomUUID();
      const session = groupSession;
      tasks.set(id, token);
      const channel = `pi-subagent-ready-${id}`;
      const command = `tmux wait-for ${shellQuote(channel)}; exec pi ${[...args, "--name", title, "--extension", extensionPath, "--", params.task].map(shellQuote).join(" ")}`;
      const environment = ["-e", `PI_SUBAGENT_ID=${id}`, "-e", `PI_SUBAGENT_TOKEN=${token}`, "-e", `PI_SUBAGENT_SOCKET=${socketPath}`];
      let windowId: string;
      try {
        const createWindow = () => exec("tmux", ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `${session}:`, "-n", title, "-c", cwd, ...environment, command]);
        if ((await exec("tmux", ["has-session", "-t", `=${session}`]).then(() => true, () => false))) {
          windowId = (await createWindow()).stdout.trim();
        } else {
          try {
            windowId = (await exec("tmux", ["new-session", "-d", "-P", "-F", "#{window_id}", "-s", session, "-n", title, "-c", cwd, ...environment, command])).stdout.trim();
          } catch (error) {
            // Another main Pi may have created the shared session concurrently.
            await exec("tmux", ["has-session", "-t", `=${session}`]);
            windowId = (await createWindow()).stdout.trim();
          }
        }
        try {
          await exec("tmux", ["set-option", "-w", "-t", windowId, "remain-on-exit", "on"]);
          await exec("tmux", ["set-option", "-w", "-t", windowId, "automatic-rename", "off"]);
          await exec("tmux", ["rename-window", "-t", windowId, title]);
        } finally {
          await exec("tmux", ["wait-for", "-S", channel]);
        }
      } catch (error) {
        tasks.delete(id);
        throw error;
      }
      return {
        content: [{ type: "text" as const, text: `Started ${id} in ${session} window ${windowId} (${title}). Switch: tmux switch-client -t ${session} && tmux select-window -t ${windowId}\nInspect: tmux capture-pane -p -S - -t ${windowId}\nClean up: tmux kill-window -t ${windowId}` }],
        details: { id, session, windowId },
      };
    },
  });
}
