import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDeclaration {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface SupervisorOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Merged over process.env. */
  env?: Record<string, string>;
  /** Default timeout for request(), in ms. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SupervisorEvents {
  message: [JsonRpcMessage];
  stderr: [string];
  tools: [ToolDeclaration[]];
  toolsChanged: [];
  parseError: [string, Error];
  error: [Error];
  exit: [code: number | null, signal: NodeJS.Signals | null];
}

export class SubprocessSupervisor extends EventEmitter<SupervisorEvents> {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  /** Outgoing tools/list request ids -> whether they carried a pagination cursor. */
  private readonly toolsListRequests = new Map<JsonRpcId, boolean>();
  private readonly tools = new Map<string, ToolDeclaration>();
  private toolsCached = false;

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Whether a complete tools/list response has been observed. */
  get hasToolCache(): boolean {
    return this.toolsCached;
  }

  getTools(): ToolDeclaration[] {
    return [...this.tools.values()];
  }

  getTool(name: string): ToolDeclaration | undefined {
    return this.tools.get(name);
  }

  start(): void {
    if (this.child) throw new Error("Supervisor already started");
    const { command, args = [], cwd, env } = this.options;

    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    child.stdin.on("error", () => {
      /* EPIPE after upstream exit is reported via 'exit' */
    });
    child.on("error", (err) => {
      this.failPending(err);
      this.emit("error", err);
    });
    child.on("close", (code, signal) => {
      this.flushBuffer();
      this.failPending(new Error(`Upstream exited (code=${code}, signal=${signal})`));
      this.emit("exit", code, signal);
    });
  }

  /** Write one JSON-RPC message to the upstream stdin, newline-delimited. */
  send(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || !this.running) throw new Error("Upstream process is not running");

    if (message.method === "tools/list" && message.id !== undefined && message.id !== null) {
      const params = message.params as { cursor?: unknown } | undefined;
      this.toolsListRequests.set(message.id, params?.cursor != null);
    }
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) });
  }

  /** Send a request with an auto-assigned id and await its response. */
  request(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.toolsListRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Fetch every page of tools/list from upstream, populating the cache. */
  async refreshTools(): Promise<ToolDeclaration[]> {
    let cursor: string | undefined;
    do {
      const res = await this.request("tools/list", cursor ? { cursor } : {});
      if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
      cursor = (res.result as { nextCursor?: string } | undefined)?.nextCursor;
    } while (cursor);
    return this.getTools();
  }

  async stop(graceMs = 2000): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
      child.once("close", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private flushBuffer(): void {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim()) this.handleLine(rest);
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) throw new Error("Not a JSON-RPC object");
    } catch (err) {
      this.emit("parseError", line, err as Error);
      return;
    }

    if (msg.method === "notifications/tools/list_changed") {
      this.toolsCached = false;
      this.emit("toolsChanged");
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = hasId && msg.method === undefined && ("result" in msg || "error" in msg);
    if (isResponse) {
      const id = msg.id as JsonRpcId;
      if (this.toolsListRequests.has(id)) {
        this.captureTools(id, msg);
      }
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(msg);
      }
    }

    this.emit("message", msg);
  }

  private captureTools(id: JsonRpcId, msg: JsonRpcMessage): void {
    const paged = this.toolsListRequests.get(id) ?? false;
    this.toolsListRequests.delete(id);
    const tools = (msg.result as { tools?: unknown } | undefined)?.tools;
    if (msg.error || !Array.isArray(tools)) return;

    if (!paged) this.tools.clear();
    for (const t of tools) {
      if (t && typeof (t as ToolDeclaration).name === "string") {
        this.tools.set((t as ToolDeclaration).name, t as ToolDeclaration);
      }
    }
    this.toolsCached = true;
    this.emit("tools", this.getTools());
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    this.toolsListRequests.clear();
  }
}
