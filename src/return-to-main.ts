import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface MainLocation { socket: string; pane: string }
/** Navigate only to the original, currently online parent. Never guess the last session. */
export async function returnToMain(location: MainLocation, owner: string, fromPane: string): Promise<void> {
  if (!/^%\d+$/.test(location.pane) || !/^%\d+$/.test(fromPane)) throw new Error("Invalid tmux pane identity");
  const tmux = (args: string[]) => exec("tmux", ["-S", location.socket, ...args]);
  const { stdout } = await tmux(["display-message", "-p", "-t", location.pane, "#{pane_id}\t#{pane_dead}\t#{@pi_subagent_main}\t#{session_name}\t#{window_id}"]);
  const [pane, dead, identity, session, window] = stdout.trim().split("\t");
  if (pane !== location.pane || dead !== "0" || identity !== owner || !session || !window) throw new Error("The original main pane exited or its identity changed; refusing to jump to another session.");
  const clients = (await tmux(["list-clients", "-F", "#{client_tty}\t#{pane_id}"])).stdout.trim().split("\n").map(row => row.split("\t")).filter(([, p]) => p === fromPane);
  if (clients.length !== 1) throw new Error("Cannot uniquely identify the current tmux client; return to the main window manually.");
  await tmux(["switch-client", "-c", clients[0][0], "-t", session]);
  await tmux(["select-window", "-t", window]);
  await tmux(["select-pane", "-t", pane]);
}
