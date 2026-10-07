import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaskStore, ownerKey, storageRoot, type TaskRecord } from "./task-store.js";
import { request, serve } from "./channel.js";
import { childExtension } from "./child.js";
import { installTree, type TaskView } from "./agent-tree.js";
import { resultCard, type ResultDetails } from "./result-card.js";

const exec = promisify(execFile);
const extensionPath = fileURLToPath(import.meta.url);
const groupSession = "pi-tmux-subagents";
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function argsForChild(args: string[]): string[] {
  const valueOptions = new Set(["--model", "--provider", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--session-dir"]);
  const incompatible = new Set(["--print", "-p", "--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork", "--mode", "--export", "--list-models", "--help", "-h", "--version", "-v", "--name", "-n", "--no-session", "--"]);
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


export default function subagent(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_ID) { childExtension(pi); return; }
  let current: ExtensionContext | undefined;
  let store: TaskStore | undefined;
  let parent: Awaited<ReturnType<typeof serve>> | undefined;
  let initializing: Promise<void> | undefined;
  let tree: ReturnType<typeof installTree> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let views: TaskView[] = [];
  let polling = false;
  let generation = 0;
  const followups = new Set<string>();
  const removals = new Set<string>();
  const close = () => {
    generation++;
    if (timer) clearInterval(timer); timer = undefined;
    tree?.close(); tree = undefined;
    parent?.close(); parent = undefined;
    current = undefined; store = undefined; views = [];
  };
  pi.on("session_shutdown", close);
  pi.on("session_before_switch", close);
  pi.on("session_before_fork", close);

  async function paneInfo(record: TaskRecord): Promise<{ exists: boolean; alive: boolean; windowId?: string; session?: string }> {
    try {
      const { stdout } = await exec("tmux", ["-S", record.tmuxSocket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}\t#{@pi_subagent_id}\t#{window_id}\t#{session_name}"]);
      const row = stdout.trim().split("\n").map(line => line.split("\t")).find(([pane, , id]) => pane === record.paneId && id === record.id);
      return row ? { exists: true, alive: row[1] === "0", windowId: row[3], session: row[4] } : { exists: false, alive: false };
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (/no server running|No such file or directory|Connection refused/.test(stderr)) return { exists: false, alive: false };
      throw new Error("Cannot verify whether the original pane is alive; refusing to guess or restore. " + stderr);
    }
  }
  async function refresh() {
    if (!store || polling) return;
    polling = true; const snapshot = store; const version = generation;
    try {
      const records = snapshot.list();
      const panes = new Map<string, { id: string; alive: boolean }>();
      await Promise.all([...new Set(records.map(r => r.tmuxSocket))].map(async socket => {
        try {
          const { stdout } = await exec("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}\t#{@pi_subagent_id}"]);
          for (const line of stdout.trim().split("\n")) {
            const [pane, dead, id] = line.split("\t");
            panes.set(`${socket}:${pane}`, { id, alive: dead === "0" });
          }
        } catch { /* Missing server means panes are absent, not tasks completed. */ }
      }));
      const next = records.map(record => {
        const pane = panes.get(`${record.tmuxSocket}:${record.paneId}`);
        const exists = pane?.id === record.id;
        return { record, state: snapshot.state(record.id), exists, alive: exists && pane!.alive };
      });
      if (version === generation) { views = next; tree?.refresh(); }
    } finally { polling = false; }
  }
  async function open(view: TaskView) {
    const { record } = view;
    const verified = await paneInfo(record);
    if (!verified.exists) throw new Error("The original pane closed or its identity changed; refusing to enter another task or restore automatically.");
    const { stdout } = await exec("tmux", ["-S", record.tmuxSocket, "list-clients", "-F", "#{client_tty}\t#{pane_id}"]);
    const clients = stdout.trim().split("\n").map(s => s.split("\t")).filter(([, pane]) => pane === process.env.TMUX_PANE);
    if (clients.length !== 1) throw new Error("Cannot uniquely identify the current tmux client; switch manually to " + record.paneId);
    await exec("tmux", ["-S", record.tmuxSocket, "switch-client", "-c", clients[0][0], "-t", verified.session!]);
    await exec("tmux", ["-S", record.tmuxSocket, "select-window", "-t", verified.windowId!]);
    await exec("tmux", ["-S", record.tmuxSocket, "select-pane", "-t", record.paneId]);
  }
  async function removeTask(record: TaskRecord, ctx: ExtensionContext): Promise<void> {
    if (!store || record.owner !== store.owner || !current || current.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("This task does not belong to the current main session.");
    if (removals.has(record.id) || followups.has(record.id)) throw new Error("Another operation on this task is in progress; try again later.");
    removals.add(record.id);
    const localStore = store;
    let confirmed = false;
    const confirmInterrupt = async () => {
      if (!ctx.hasUI || !await ctx.ui.confirm("Interrupt and remove subagent?", `${record.title} is running or its state is unknown. This interrupts work and closes its pane. Session history and project files will be preserved.`)) return false;
      confirmed = true; return true;
    };
    try {
      const initial = await paneInfo(record);
      const state = localStore.state(record.id);
      if (initial.alive && (!state || state.status === "running" || state.reportPending) && !await confirmInterrupt()) return;
      record.removing = true; localStore.save(record);
      if (initial.alive && state?.activeSessionId && state.activeSessionId !== state.sessionId) throw new Error("The child Pi switched sessions; refusing to close unrelated work.");
      if (initial.alive && !state?.controlSocket) throw new Error("The child cannot receive shutdown requests. Run /reload or exit it manually, then remove it. It will not be force-killed.");
      if (initial.alive && state?.controlSocket) {
        let reply = await request(state.controlSocket, { kind: "remove", id: record.id, owner: record.owner, token: record.token, confirmInterrupt: confirmed });
        if (reply.needsConfirmation) {
          if (!confirmed && !await confirmInterrupt()) return;
          reply = await request(state.controlSocket, { kind: "remove", id: record.id, owner: record.owner, token: record.token, confirmInterrupt: true });
        }
        if (!reply.ok) throw new Error(reply.error ?? "The child refused removal.");
        for (let i = 0; i < 40 && (await paneInfo(record)).alive; i++) await new Promise(resolve => setTimeout(resolve, 50));
      }
      const latest = localStore.state(record.id);
      if (latest?.activeSessionId && latest.activeSessionId !== latest.sessionId) throw new Error("The child Pi switched sessions; refusing to close unrelated work.");
      const verified = await paneInfo(record);
      if (verified.alive) throw new Error("The child has not exited. It was not force-killed. Try removal again later or exit it manually.");
      // Never kill a whole window: the user may have added unrelated sibling panes.
      if (verified.exists) await exec("tmux", ["-S", record.tmuxSocket, "kill-pane", "-t", record.paneId]);
      else if (state?.pid) {
        let alive = false;
        try { process.kill(state.pid, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") alive = true; }
        if (alive) throw new Error("The original pane is missing, but Pi may still be alive. Cannot safely close it; inspect manually.");
      }
      record.removedAt = Date.now(); record.removing = false; localStore.save(record);
      await refresh();
      if (ctx.hasUI) ctx.ui.notify(`Removed ${record.title}. Session history and project files were preserved.`, "info");
    } finally {
      removals.delete(record.id);
      if (!record.removedAt && record.removing) { record.removing = false; localStore.save(record); }
    }
  }
  pi.registerCommand("subagent-remove", {
    description: "Remove a child Pi and its pane from this main session's list; confirms interruption of active work; keeps session history and files",
    handler: async (args, ctx) => {
      await activate(ctx);
      let record: TaskRecord | undefined;
      if (args.trim()) record = store!.get(args.trim());
      else {
        const records = store!.list();
        if (!records.length) { ctx.ui.notify("No subagents to remove.", "info"); return; }
        const options = records.map((r, i) => `${i + 1}. ${r.title} · ${r.id.slice(0, 8)}`);
        const choice = await ctx.ui.select("Remove which subagent?", options);
        if (!choice) return;
        record = records[options.indexOf(choice)];
      }
      if (!record || record.removedAt) { ctx.ui.notify("No matching subagent in the current main session.", "warning"); return; }
      try { await removeTask(record, ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerMessageRenderer<ResultDetails>("subagent-result", (message, options, theme) => {
    const content = typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
    const details = message.details ?? {};
    const id = details.taskId ?? details.receipt?.split(":")[0] ?? content.match(/^(?:子任务|Subagent) ([a-zA-Z0-9_-]+)/)?.[1];
    if (!id) return undefined;
    const record = store?.get(id);
    return resultCard(content, { ...details, title: details.title ?? record?.title }, theme, options.outputPad, async () => {
      const target = store?.get(id);
      if (!current || !target || target.removedAt) throw new Error("This subagent was removed or does not belong to the current main session.");
      await open({ record: target, state: store!.state(id), exists: true, alive: true });
    }, error => { if (current?.hasUI) current.ui.notify(error instanceof Error ? error.message : String(error), "error"); });
  });
  async function activate(ctx: ExtensionContext) {
    const owner = ownerKey(ctx.sessionManager.getSessionId());
    if (parent && store?.owner === owner) { current = ctx; return; }
    if (initializing) { await initializing; if (store?.owner === owner) return; }
    close(); current = ctx;
    const localStore = new TaskStore(storageRoot(), owner); store = localStore;
    // A restarted runtime does not inherit an in-memory removal operation.
    for (const record of localStore.list()) if (record.removing) { record.removing = false; localStore.save(record); }
    initializing = (async () => {
      let main: { socket: string; pane: string } | undefined;
      if (ctx.mode === "tui" && process.env.TMUX && process.env.TMUX_PANE) {
        const socket = process.env.TMUX.split(",")[0];
        const pane = process.env.TMUX_PANE;
        await exec("tmux", ["-S", socket, "set-option", "-p", "-t", pane, "@pi_subagent_main", owner]);
        main = { socket, pane };
      }
      parent = await serve(message => {
        if (!current || ownerKey(current.sessionManager.getSessionId()) !== owner || message.owner !== owner) return { ok: false, error: "Original main session is offline" };
        const record = typeof message.id === "string" ? localStore.get(message.id) : undefined;
        if (!record || record.token !== message.token || record.removedAt || record.removing) return { ok: false, error: "Invalid task credentials" };
        if (message.kind === "locate-main") return main ? { ok: true, main } : { ok: false, error: "The original main session is not in a navigable tmux pane." };
        if (message.kind !== "result" || typeof message.text !== "string" || !message.text.trim() || typeof message.round !== "string") return { ok: false, error: "Invalid result payload" };
        const receipt = `${record.id}:${message.explicit ? "explicit:" : "round:"}${message.round}`;
        if (localStore.hasReceipt(receipt)) return { ok: true };
        if (!message.explicit) {
          const state = localStore.state(record.id);
          if (message.round !== record.round || (state && (state.round !== message.round || state.mode !== "delegated"))) return { ok: false, error: "Stale or user-owned round; automatic report cancelled" };
        }
        const content = `Subagent ${record.id} (${record.title}) — ${message.explicit ? "Summary" : "Report"}:\n${message.text}`;
        // ACK means accepted by the original session, not that its model finished processing.
        const details: ResultDetails = { receipt, taskId: record.id, title: record.title, text: message.text, explicit: !!message.explicit };
        pi.appendEntry("subagent-received", { ...details, content, timestamp: Date.now() });
        localStore.receipt(receipt);
        try {
          pi.sendMessage({ customType: "subagent-result", content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
        } catch {
          if (current.hasUI) current.ui.notify("Subagent result received, but automatic wake-up failed. The result remains in the original session context.", "error");
        }
        void refresh();
        return { ok: true };
      });
      localStore.setEndpoint({ socket: parent.path, pid: process.pid });
      if (ctx.mode === "tui" && ctx.hasUI) {
        tree = installTree(ctx, () => views, open, view => removeTask(view.record, ctx));
        timer = setInterval(() => { void refresh().catch(() => {}); }, 500); timer.unref();
      }
      await refresh();
    })();
    try { await initializing; } catch (error) { close(); throw error; } finally { initializing = undefined; }
  }
  pi.on("session_start", async (_event, ctx) => { await activate(ctx); });
  pi.on("context", (event, ctx) => {
    // Accepted results are part of the original session journal, not an offline inbox.
    // This also protects model context if fire-and-forget sendMessage cannot start a turn.
    const messages = [...event.messages];
    const received = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "subagent-received");
    for (const entry of received) {
      if (entry.type !== "custom") continue;
      const data = entry.data as ResultDetails & { content?: string; timestamp?: number };
      if (!data?.receipt || !data.content || messages.some(m => m.role === "custom" && (m.details as { receipt?: string } | undefined)?.receipt === data.receipt)) continue;
      messages.push({ role: "custom", customType: "subagent-result", content: data.content, display: true, details: { receipt: data.receipt, taskId: data.taskId, title: data.title, text: data.text, explicit: data.explicit }, timestamp: data.timestamp ?? 0 });
    }
    return { messages };
  });

  function tmuxSocket(): string {
    const socket = process.env.TMUX?.split(",")[0];
    if (!socket) throw new Error("Subagents require Pi to run inside tmux");
    return socket;
  }
  async function launch(record: TaskRecord, restore = false) {
    const tmux = (args: string[]) => exec("tmux", ["-S", record.tmuxSocket, ...args]);
    const channel = `pi-subagent-ready-${randomUUID()}`;
    const args = [...record.piArgs, "--name", record.title, "--extension", extensionPath];
    if (restore) args.push("--session", store!.state(record.id)!.sessionFile!);
    else args.push("--", record.task);
    const env = { PI_SUBAGENT_ID: record.id, PI_SUBAGENT_OWNER: record.owner, PI_SUBAGENT_TOKEN: record.token, PI_SUBAGENT_ROOT: store!.root, PI_SUBAGENT_RESTORE: restore ? "1" : "0" };
    const command = `tmux -S ${shellQuote(record.tmuxSocket)} wait-for ${shellQuote(channel)}; exec env ${Object.entries(env).map(([k, v]) => shellQuote(`${k}=${v}`)).join(" ")} pi ${args.map(shellQuote).join(" ")}`;
    let launched = false;
    try {
      const existing = restore ? await paneInfo(record) : { exists: false, alive: false };
      if (existing.alive) throw new Error("Subagent is still alive; enter its pane instead of restoring");
      if (restore) {
        const pid = store!.state(record.id)?.pid;
        if (pid) {
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") alive = true; }
          if (alive) throw new Error("Original Pi process may still be alive; refusing duplicate restoration");
        }
      }
      if (existing.exists) {
        await tmux(["respawn-pane", "-k", "-t", record.paneId, "-c", record.cwd, command]); launched = true;
      } else {
        const sessionExists = () => tmux(["has-session", "-t", `=${groupSession}`]).then(() => true, () => false);
        for (let attempt = 0; attempt < 3; attempt++) {
          const exists = await sessionExists();
          try {
            const { stdout } = await tmux(exists
              ? ["new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}", "-t", `${groupSession}:`, "-n", record.title, "-c", record.cwd, command]
              : ["new-session", "-d", "-P", "-F", "#{window_id}\t#{pane_id}", "-s", groupSession, "-n", record.title, "-c", record.cwd, command]);
            [record.windowId, record.paneId] = stdout.trim().split("\t"); launched = true; break;
          } catch (error) { if (exists === await sessionExists() || attempt === 2) throw error; }
        }
      }
      if (!launched || !record.paneId) throw new Error("Could not create a subagent pane");
      await tmux(["set-option", "-w", "-t", record.windowId, "remain-on-exit", "on"]);
      await tmux(["set-option", "-w", "-t", record.windowId, "automatic-rename", "off"]);
      await tmux(["set-option", "-p", "-t", record.paneId, "@pi_subagent_id", record.id]);
      store!.save(record);
    } finally { if (launched) await tmux(["wait-for", "-S", channel]); }
  }
  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: "Start an independent interactive Pi in tmux, immediately returning while a delegated round later reports to this original session and remains idle. Use action=followup with id to delegate another round ONLY after the user hands it back using /subagent-handoff in that child; never grab user collaboration. Use action=restore ONLY on explicit user request, reopening the exact saved session without running a task. Choose mode=user for user-led collaboration (no automatic reports). Supply title project｜work and complete context/read-only requirements. No recursive delegation.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("followup"), Type.Literal("restore")])),
      id: Type.Optional(Type.String({ description: "Exact existing task ID for followup or restore" })),
      task: Type.Optional(Type.String({ description: "Complete initial task or next explicit delegation" })),
      title: Type.Optional(Type.String({ description: "Short project name｜specific work, 1–80 characters" })),
      piArgs: Type.Optional(Type.Array(Type.String({ description: "Pi CLI options, not a shell command" }))),
      cwd: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal("delegated"), Type.Literal("user")])),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      // Validate launch arguments before side effects.
      const action = params.action ?? "start";
      const args = action === "start" ? argsForChild(params.piArgs ?? []) : undefined;
      if (action === "start") {
        if (!params.task?.trim()) throw new Error("task is required");
        if (!params.title || /[\x00-\x1f\x7f]/.test(params.title) || !params.title.trim() || [...params.title.trim()].length > 80) throw new Error("title must be 1–80 characters without control characters");
        if (!statSync(params.cwd ?? ctx.cwd).isDirectory()) throw new Error("cwd is not a directory");
      }
      await activate(ctx);
      let record: TaskRecord;
      if (action === "start") {
        record = { id: randomUUID(), token: randomUUID(), owner: store!.owner, parentSessionId: ctx.sessionManager.getSessionId(), parentSessionFile: ctx.sessionManager.getSessionFile(), title: params.title!.trim(), task: params.task!, cwd: params.cwd ?? ctx.cwd, piArgs: args!, mode: params.mode ?? "delegated", round: randomUUID(), createdAt: Date.now(), windowId: "", paneId: "", tmuxSocket: tmuxSocket() };
        store!.save(record);
        await launch(record);
      } else {
        if (!params.id) throw new Error("id is required");
        const found = store!.get(params.id);
        if (!found || found.removedAt || found.removing) throw new Error("Task is removed, being removed, or does not belong to this original main session");
        record = found;
        if (action === "followup") {
          if (!params.task?.trim()) throw new Error("task is required for followup");
          if (followups.has(record.id) || removals.has(record.id)) throw new Error("Another operation on this session is already in progress");
          followups.add(record.id);
          const localStore = store!;
          try {
            record = localStore.get(record.id)!;
            if (record.removedAt || record.removing) throw new Error("Task is being removed");
            const state = localStore.state(record.id);
            if (!state?.controlSocket || !(await paneInfo(record)).alive) throw new Error("Subagent is offline; ask user before restoring");
            if (!state.handoff) throw new Error("Please run /subagent-handoff in the child session first.");
            const nextRound = randomUUID();
            const credentials = { id: record.id, token: record.token, owner: record.owner };
            const ready = await request(state.controlSocket, { ...credentials, kind: "prepare-delegate", round: nextRound });
            if (!ready.ok || !ready.state || ready.state.activeSessionId !== state.sessionId) throw new Error(ready.error ?? "Original child session changed");
            const oldRound = ready.state.round;
            record.round = nextRound; localStore.save(record);
            try {
              const reply = await request(state.controlSocket, { ...credentials, kind: "delegate", expectedRound: oldRound, round: nextRound, task: params.task });
              if (!reply.ok) { record.round = oldRound; localStore.save(record); throw new Error(reply.error); }
            } catch (error) {
              // A transport timeout is not proof of rejection. Ask the child which round it accepted.
              const actual = await request(state.controlSocket, { ...credentials, kind: "status" }).catch(() => undefined);
              if (actual?.ok && actual.state?.round === nextRound && actual.state.activeSessionId === state.sessionId) {
                record.round = nextRound; localStore.save(record);
              } else {
                if (actual?.ok && actual.state?.round === oldRound) { record.round = oldRound; localStore.save(record); }
                throw error;
              }
            }
          } finally { followups.delete(record.id); }
        } else {
          if (!store!.sessionExists(record.id)) throw new Error("Exact saved session file is missing; cannot restore");
          const state = store!.state(record.id)!;
          const header = JSON.parse(readFileSync(state.sessionFile!, "utf8").split("\n")[0]);
          if (header.type !== "session" || header.id !== state.sessionId) throw new Error("Saved session identity does not match; refusing to guess");
          await launch(record, true);
        }
      }
      await refresh();
      const switchCommand = `tmux -S ${shellQuote(record.tmuxSocket)} switch-client -t ${groupSession} && tmux -S ${shellQuote(record.tmuxSocket)} select-pane -t ${record.paneId}`;
      return { content: [{ type: "text", text: `${action === "start" ? "Started" : action === "restore" ? "Restored (idle, user-owned)" : "Delegated another round to"} ${record.id} in ${groupSession} window ${record.windowId}, pane ${record.paneId} (${record.title}).\nSwitch: ${switchCommand}\nInspect: tmux -S ${shellQuote(record.tmuxSocket)} capture-pane -p -S - -t ${record.paneId}\nReports do not imply project acceptance; Pi remains available for conversation. Esc or direct input takes over and cancels unsent automatic reports.` }], details: { id: record.id, session: groupSession, windowId: record.windowId, paneId: record.paneId } };
    },
  });
}
