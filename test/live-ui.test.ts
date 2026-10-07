import { expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore } from "../src/task-store.js";
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test.skipIf(process.env.PI_SUBAGENT_LIVE_TEST !== "1")("real fullscreen result click enters child, /main returns, and command removes the idle child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-live-ui-"));
  const socket = join(dir, "tmux.sock");
  const root = join(dir, "records");
  const tmux = (args: string[]) => exec("tmux", ["-S", socket, ...args]);
  let client: ReturnType<typeof spawn> | undefined;
  let pane = "";
  async function waitFor(check: () => Promise<boolean> | boolean, label: string, timeout = 60000) {
    const start = Date.now();
    while (!await check()) { if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`); await new Promise(r => setTimeout(r, 100)); }
  }
  try {
    const prompt = 'Use subagent exactly once: title="live-test｜点击验收", task="Reply only CLICK_READY. Do not use tools.", piArgs=["--no-extensions","--no-skills","--no-prompt-templates","--no-context-files","--offline","--thinking","low"]. Do not change files. After the child reports, only say READY and wait; no more tools.';
    const args = ["env", `PI_SUBAGENT_ROOT=${root}`, "PI_SUBAGENT_ID=", "pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--offline", "--thinking", "low", "--tui-mode", "fullscreen", "--session-dir", join(dir, "sessions"), "--extension", resolve("src/subagent.ts"), "--", prompt];
    pane = (await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "parent", "-x", "120", "-y", "40", args.map(quote).join(" ")])).stdout.trim();
    client = spawn("script", ["-q", "-c", `tmux -S '${socket}' attach-session -t parent`, "/dev/null"], { env: { ...process.env, TERM: "xterm-256color" }, stdio: ["pipe", "ignore", "ignore"] });
    let store: TaskStore | undefined;
    await waitFor(() => { try { const owner = readdirSync(root)[0]; store = new TaskStore(root, owner); return store.list().length === 1 && /^%\d+$/.test(store.list()[0].paneId); } catch { return false; } }, "created child");
    const record = store!.list()[0];
    await waitFor(() => store!.state(record.id)?.delivery === "sent", "actual report card");
    let lines: string[] = [];
    let row = -1;
    await waitFor(async () => { lines = (await tmux(["capture-pane", "-p", "-t", pane])).stdout.split("\n"); row = lines.findIndex(line => line.includes("↗ live-test｜点击验收")); return row >= 0 && lines.some(line => line.trim() === "READY") && !lines.some(line => line.includes("Working")); }, "stable clickable card after parent settlement");
    await new Promise(r => setTimeout(r, 200));
    lines = (await tmux(["capture-pane", "-p", "-t", pane])).stdout.split("\n");
    row = lines.findIndex(line => line.includes("↗ live-test｜点击验收"));
    expect(row).toBeGreaterThanOrEqual(0);
    // Screen-relative SGR mouse press/release; only our isolated client is affected.
    await tmux(["send-keys", "-l", "-t", pane, `\x1b[<0;5;${row + 1}M\x1b[<0;5;${row + 1}m`]);
    await waitFor(async () => (await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.trim() === record.paneId, "click navigation", 5000);
    const beforeReload = store!.state(record.id)!.controlSocket;
    await tmux(["send-keys", "-l", "-t", record.paneId, "/reload"]); await tmux(["send-keys", "-t", record.paneId, "Enter"]);
    await waitFor(() => !!store!.state(record.id)?.controlSocket && store!.state(record.id)?.controlSocket !== beforeReload, "child idle reload");
    expect(store!.state(record.id)?.handoff).toBe(true);
    await tmux(["send-keys", "-l", "-t", record.paneId, "/main"]); await tmux(["send-keys", "-t", record.paneId, "Enter"]);
    await waitFor(async () => (await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.trim() === pane, "main return command");
    expect(store!.state(record.id)?.mode).toBe("delegated");
    for (const key of ["Left", "Down"]) {
      await tmux(["send-keys", "-t", pane, "Down", "Enter"]);
      await waitFor(async () => (await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.trim() === record.paneId, "tree entry before arrow return");
      await tmux(["send-keys", "-t", record.paneId, key]);
      await waitFor(async () => (await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.trim() === pane, `${key} return to main`);
      expect(store!.state(record.id)?.mode).toBe("delegated");
    }
    await tmux(["send-keys", "-l", "-t", pane, `/subagent-remove ${record.id}`]); await tmux(["send-keys", "-t", pane, "Enter"]);
    await waitFor(() => !!store!.get(record.id)?.removedAt, "idle removal");
    expect(store!.list()).toHaveLength(0);
  } catch (error) {
    if (pane) console.error((await tmux(["capture-pane", "-p", "-S", "-60", "-t", pane]).catch(() => ({ stdout: "unavailable" }))).stdout);
    throw error;
  } finally {
    await tmux(["kill-server"]).catch(() => {});
    client?.stdin?.end(); client?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 180000);
