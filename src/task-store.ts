import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Collaboration = "delegated" | "user";
export interface TaskRecord {
  id: string; token: string; owner: string; parentSessionId?: string; parentSessionFile?: string; title: string; task: string; cwd: string;
  piArgs: string[]; mode: Collaboration; round: string; createdAt: number;
  windowId: string; paneId: string; tmuxSocket: string; removedAt?: number; removing?: boolean;
}
export interface ChildState {
  sessionFile?: string; sessionId?: string; activeSessionId?: string; pid?: number; controlSocket?: string;
  mode: Collaboration; status: "starting" | "running" | "waiting" | "error" | "exited";
  round: string; reportPending: boolean; handoff: boolean; updatedAt: number;
  startedAt?: number; endedAt?: number; turns?: number; toolUses?: number; tokens?: number; contextPercent?: number; activity?: string; lastText?: string; unsentText?: string; delivery?: "sent" | "unsent"; error?: string;
}
export interface Endpoint { socket: string; pid?: number }
export function storageRoot(): string { return process.env.PI_SUBAGENT_ROOT ?? join(homedir(), ".pi", "agent", "tmux-subagents"); }
export function ownerKey(id: string): string { return createHash("sha256").update(id).digest("hex").slice(0, 24); }
function safe(key: string): string { if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid task identity"); return key; }
export function readJson<T>(path: string): T | undefined { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } }
export function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
export class TaskStore {
  readonly dir: string;
  constructor(readonly root: string, readonly owner: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.dir = join(root, safe(owner));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  path(id: string): string { return join(this.dir, `${safe(id)}.json`); }
  get(id: string): TaskRecord | undefined { return readJson<TaskRecord>(this.path(id)); }
  save(record: TaskRecord): void { atomicJson(this.path(record.id), record); }
  list(): TaskRecord[] {
    return readdirSync(this.dir).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name) && name !== "endpoint.json" && name !== "receipts.json")
      .map(name => readJson<TaskRecord>(join(this.dir, name))).filter((r): r is TaskRecord => !!r && r.owner === this.owner && !r.removedAt && typeof r.token === "string" && typeof r.id === "string")
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  state(id: string): ChildState | undefined { return readJson<ChildState>(join(this.dir, `${safe(id)}.state.json`)); }
  saveState(id: string, state: ChildState): void { atomicJson(join(this.dir, `${safe(id)}.state.json`), state); }
  endpoint(): Endpoint | undefined { return readJson<Endpoint>(join(this.dir, "endpoint.json")); }
  setEndpoint(endpoint: Endpoint): void { atomicJson(join(this.dir, "endpoint.json"), endpoint); }
  hasReceipt(key: string): boolean { return (readJson<string[]>(join(this.dir, "receipts.json")) ?? []).includes(key); }
  receipt(key: string): void { const keys = readJson<string[]>(join(this.dir, "receipts.json")) ?? []; if (!keys.includes(key)) atomicJson(join(this.dir, "receipts.json"), [...keys, key]); }
  sessionExists(id: string): boolean { const file = this.state(id)?.sessionFile; return !!file && existsSync(file); }
}
