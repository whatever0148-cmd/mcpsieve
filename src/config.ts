import { readFile } from "node:fs/promises";
import { BM25Index } from "./bm25.js";
import {
  SubprocessSupervisor,
  type JsonRpcMessage,
  type ToolDeclaration,
} from "./supervisor.js";

export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
}

export const noopLogger: Logger = { debug() {}, warn() {} };

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpConfig {
  servers: Record<string, ServerConfig>;
  /** Entries that were recognised but not started (disabled, or not stdio). */
  skipped: { name: string; reason: string }[];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse the standard `{ "mcpServers": { ... } }` shape used by Claude Desktop and Cursor. */
export function parseConfig(raw: unknown): McpConfig {
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    throw new ConfigError('Config must be an object with an "mcpServers" object');
  }

  const servers: Record<string, ServerConfig> = {};
  const skipped: McpConfig["skipped"] = [];

  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    const where = `mcpServers.${name}`;
    if (!isRecord(entry)) throw new ConfigError(`${where} must be an object`);

    if (entry.disabled === true) {
      skipped.push({ name, reason: "disabled" });
      continue;
    }
    if (typeof entry.command !== "string" || entry.command === "") {
      if (typeof entry.url === "string") {
        skipped.push({ name, reason: "remote (url) servers are not supported, only stdio commands" });
        continue;
      }
      throw new ConfigError(`${where}.command must be a non-empty string`);
    }

    const args = entry.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new ConfigError(`${where}.args must be an array of strings`);
    }

    let env: Record<string, string> | undefined;
    if (entry.env !== undefined) {
      if (!isRecord(entry.env)) throw new ConfigError(`${where}.env must be an object`);
      env = {};
      for (const [k, v] of Object.entries(entry.env)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          throw new ConfigError(`${where}.env.${k} must be a string`);
        }
        env[k] = String(v);
      }
    }

    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      throw new ConfigError(`${where}.cwd must be a string`);
    }

    servers[name] = { command: entry.command, args: args as string[], env, cwd: entry.cwd as string | undefined };
  }

  return { servers, skipped };
}

export async function loadConfig(path: string): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(json);
}

export interface CatalogTool {
  /** `<server>__<tool>`, unique across all upstreams. */
  name: string;
  server: string;
  tool: ToolDeclaration;
}

export interface Upstream {
  supervisor: SubprocessSupervisor;
  capabilities: Record<string, unknown>;
}

export interface ConnectOptions {
  logger?: Logger;
  requestTimeoutMs?: number;
}

export const NAME_SEPARATOR = "__";
const PROTOCOL_VERSION = "2025-06-18";

function documentText(server: string, tool: ToolDeclaration): string {
  const parts = [tool.name, tool.description ?? "", server];
  const props = (tool.inputSchema as { properties?: unknown } | undefined)?.properties;
  if (isRecord(props)) {
    for (const [key, schema] of Object.entries(props)) {
      parts.push(key);
      if (isRecord(schema) && typeof schema.description === "string") parts.push(schema.description);
    }
  }
  return parts.join(" ");
}

/** Owns every upstream supervisor and the shared BM25 index over all their tools. */
export class UpstreamCatalog {
  readonly index = new BM25Index();
  private readonly upstreams = new Map<string, Upstream>();
  private readonly tools = new Map<string, CatalogTool>();
  private readonly byServer = new Map<string, string[]>();
  private closing = false;

  constructor(private readonly logger: Logger = noopLogger) {}

  get servers(): ReadonlyMap<string, Upstream> {
    return this.upstreams;
  }

  get size(): number {
    return this.tools.size;
  }

  async connect(name: string, config: ServerConfig, requestTimeoutMs?: number): Promise<void> {
    const supervisor = new SubprocessSupervisor({ ...config, requestTimeoutMs });
    supervisor.on("error", (err) => this.logger.warn(`[${name}] ${err.message}`));
    supervisor.on("stderr", (text) => this.logger.debug(`[${name}] ${text.trimEnd()}`));
    supervisor.on("parseError", (line) => this.logger.debug(`[${name}] non-JSON stdout line: ${line}`));
    supervisor.on("exit", (code, signal) => {
      if (!this.closing) {
        this.logger.warn(`[${name}] upstream exited (code=${code}, signal=${signal}); its tools were removed`);
      }
      this.upstreams.delete(name);
      this.unindex(name);
    });
    supervisor.on("toolsChanged", () => {
      supervisor.refreshTools().then(
        () => this.reindex(name, supervisor),
        (err: Error) => this.logger.warn(`[${name}] failed to refresh tools: ${err.message}`),
      );
    });

    supervisor.start();
    try {
      const init = await supervisor.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mcpsieve", version: "1.0.0" },
      });
      if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
      supervisor.notify("notifications/initialized");
      await supervisor.refreshTools();

      const capabilities = (init.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
      this.upstreams.set(name, { supervisor, capabilities: capabilities ?? {} });
      this.reindex(name, supervisor);
    } catch (err) {
      await supervisor.stop(500);
      throw err;
    }
  }

  search(query: string, limit: number): (CatalogTool & { score: number })[] {
    const out: (CatalogTool & { score: number })[] = [];
    for (const { id, score } of this.index.search(query, limit)) {
      const entry = this.tools.get(id);
      if (entry) out.push({ ...entry, score });
    }
    return out;
  }

  /** Look up by qualified name, or by bare tool name when it is unambiguous. */
  resolve(name: string): CatalogTool | undefined {
    const exact = this.tools.get(name);
    if (exact) return exact;
    const matches = [...this.tools.values()].filter((t) => t.tool.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  callTool(entry: CatalogTool, args: Record<string, unknown>, timeoutMs?: number): Promise<JsonRpcMessage> {
    const upstream = this.upstreams.get(entry.server);
    if (!upstream) return Promise.reject(new Error(`Upstream "${entry.server}" is not running`));
    return upstream.supervisor.request("tools/call", { name: entry.tool.name, arguments: args }, timeoutMs);
  }

  async close(): Promise<void> {
    this.closing = true;
    const all = [...this.upstreams.values()];
    this.upstreams.clear();
    await Promise.all(all.map((u) => u.supervisor.stop()));
  }

  private unindex(server: string): void {
    for (const id of this.byServer.get(server) ?? []) {
      this.index.removeDocument(id);
      this.tools.delete(id);
    }
    this.byServer.delete(server);
  }

  private reindex(server: string, supervisor: SubprocessSupervisor): void {
    this.unindex(server);
    const ids: string[] = [];
    for (const tool of supervisor.getTools()) {
      const id = `${server}${NAME_SEPARATOR}${tool.name}`;
      this.tools.set(id, { name: id, server, tool });
      this.index.addDocument(id, documentText(server, tool));
      ids.push(id);
    }
    this.byServer.set(server, ids);
    this.logger.debug(`[${server}] indexed ${ids.length} tools`);
  }
}

/** Start every configured server, handshake, and index their tools. Failed servers are skipped. */
export async function connectUpstreams(config: McpConfig, options: ConnectOptions = {}): Promise<UpstreamCatalog> {
  const logger = options.logger ?? noopLogger;
  const catalog = new UpstreamCatalog(logger);

  for (const { name, reason } of config.skipped) logger.warn(`Skipping server "${name}": ${reason}`);

  const entries = Object.entries(config.servers);
  const results = await Promise.allSettled(
    entries.map(([name, cfg]) => catalog.connect(name, cfg, options.requestTimeoutMs)),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      logger.warn(`Failed to start server "${entries[i]![0]}": ${(r.reason as Error).message}`);
    }
  });

  logger.debug(`${catalog.size} tools indexed from ${catalog.servers.size}/${entries.length} servers`);
  return catalog;
}
