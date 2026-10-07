import { expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { returnToMain } from "../src/return-to-main.js";
const exec = promisify(execFile);

test("returns the active client to the verified original parent, not the last session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-return-"));
  const socket = join(dir, "tmux.sock");
  const tmux = (args: string[]) => exec("tmux", ["-S", socket, ...args]);
  let client: ReturnType<typeof spawn> | undefined;
  try {
    const parentPane = (await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "original", "-x", "80", "-y", "24", "sleep 60"])).stdout.trim();
    const childPane = (await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "children", "sleep 60"])).stdout.trim();
    await tmux(["set-option", "-p", "-t", parentPane, "@pi_subagent_main", "original-owner"]);
    // Own PTY/client on an isolated server: never switch a user's real client.
    client = spawn("script", ["-q", "-c", `tmux -S '${socket}' attach-session -t children`, "/dev/null"], { env: { ...process.env, TERM: "xterm-256color" }, stdio: ["pipe", "ignore", "ignore"] });
    const deadline = Date.now() + 5000;
    while (!(await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.includes(childPane)) {
      if (Date.now() > deadline) throw new Error("Isolated client failed to attach");
      await new Promise(r => setTimeout(r, 50));
    }
    await expect(returnToMain({ socket, pane: parentPane }, "wrong-owner", childPane)).rejects.toThrow(/identity/);
    expect((await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.trim()).toBe(childPane);
    await returnToMain({ socket, pane: parentPane }, "original-owner", childPane);
    expect((await tmux(["list-clients", "-F", "#{pane_id}"])).stdout.trim()).toBe(parentPane);
  } finally {
    await tmux(["kill-server"]).catch(() => {});
    client?.stdin?.end();
    client?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
