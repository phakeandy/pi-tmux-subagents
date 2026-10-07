import { createServer, connect, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Reply { ok: boolean; error?: string; needsConfirmation?: boolean; state?: { round: string; activeSessionId?: string }; main?: { socket: string; pane: string } }
const MAX_BYTES = 1024 * 1024;
/** One bounded request/acknowledgement, not a durable mailbox. */
export async function request(socketPath: string, value: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let body = "";
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } socket.destroy(); };
    socket.setTimeout(3000, () => fail(new Error("Acknowledgement timeout")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", chunk => {
      body += chunk.toString();
      if (body.length > MAX_BYTES) return fail(new Error("Reply too large"));
      const end = body.indexOf("\n");
      if (end < 0) return;
      try { const reply = JSON.parse(body.slice(0, end)); if (typeof reply.ok !== "boolean") throw new Error("Invalid acknowledgement"); settled = true; resolve(reply); socket.destroy(); } catch { fail(new Error("Invalid acknowledgement")); }
    });
    socket.on("close", () => { if (!settled) fail(new Error("Connection closed without acknowledgement")); });
  });
}
export async function serve(handler: (value: any) => Promise<Reply> | Reply): Promise<{ path: string; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
  const path = join(dir, "channel.sock");
  const connections = new Set<Socket>();
  const server: Server = createServer(socket => {
    connections.add(socket); socket.on("close", () => connections.delete(socket));
    socket.setTimeout(3000, () => socket.destroy());
    let body = ""; let handled = false;
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (handled) return;
      body += chunk.toString();
      if (body.length > MAX_BYTES) { socket.destroy(); return; }
      const end = body.indexOf("\n");
      if (end < 0) return;
      handled = true;
      void (async () => {
        let reply: Reply;
        try { reply = await handler(JSON.parse(body.slice(0, end))); } catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : "Channel error" }; }
        if (!socket.destroyed) socket.end(JSON.stringify(reply) + "\n");
      })();
    });
  });
  const close = () => { for (const s of connections) s.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); };
  try { await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve)); } catch (error) { close(); throw error; }
  return { path, close };
}
