import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { noopLogger, type Logger, type UpstreamCatalog } from "./config.js";
import type { JsonRpcId, JsonRpcMessage } from "./supervisor.js";

export const SEARCH_TOOL = "mcp_sieve_search";
export const INVOKE_TOOL = "mcp_sieve_invoke";
export const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 50;

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "mcpsieve", version: "1.0.0" };

export const META_TOOLS = [
  {
    name: SEARCH_TOOL,
    description:
      "Search the catalog of available tools by keyword. Returns matching tool names, descriptions and input " +
      `schemas. Call this first, then run a chosen tool with ${INVOKE_TOOL}.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need" },
        limit: { type: "number", description: "Maximum number of results", default: DEFAULT_SEARCH_LIMIT },
      },
      required: ["query"],
    },
  },
  {
    name: INVOKE_TOOL,
    description: `Execute a tool found via ${SEARCH_TOOL}. Pass its exact name and arguments matching its input schema.`,
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: `Tool name exactly as returned by ${SEARCH_TOOL}` },
        arguments: { type: "object", description: "Arguments for the tool, per its input schema" },
      },
      required: ["tool_name"],
    },
  },
];

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError }),
});

export interface ProxyOptions {
  catalog: UpstreamCatalog;
  input?: Readable;
  output?: Writable;
  logger?: Logger;
  /** Timeout for proxied tools/call requests, in ms. */
  invokeTimeoutMs?: number;
}

/** A virtual MCP server that exposes two meta-tools in place of every upstream tool. */
export class McpProxy {
  private readonly catalog: UpstreamCatalog;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly logger: Logger;
  private readonly invokeTimeoutMs: number;
  private readonly inflight = new Set<Promise<void>>();
  private rl?: Interface;

  constructor(options: ProxyOptions) {
    this.catalog = options.catalog;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.logger = options.logger ?? noopLogger;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 120_000;
  }

  /** Serve until the input stream ends (or close() is called), then shut down the upstreams. */
  start(): Promise<void> {
    this.output.on("error", (err) => this.logger.debug(`output error: ${err.message}`));

    for (const [name, { supervisor }] of this.catalog.servers) {
      supervisor.on("message", (msg) => {
        if (msg.method === "notifications/message") {
          this.logger.debug(`[${name}] forwarding log notification`);
          this.write({ jsonrpc: "2.0", method: msg.method, params: msg.params });
        }
      });
    }

    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl = rl;
    return new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        const p: Promise<void> = this.handleLine(line).finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      });
      rl.on("close", () => {
        void Promise.allSettled([...this.inflight])
          .then(() => this.catalog.close())
          .then(() => resolve());
      });
    });
  }

  close(): void {
    this.rl?.close();
  }

  private write(msg: JsonRpcMessage): void {
    if (this.output.writable) this.output.write(JSON.stringify(msg) + "\n");
  }

  private reply(id: JsonRpcId | null, error: { code: number; message: string }): void {
    this.write({ jsonrpc: "2.0", id, error });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.reply(null, { code: -32700, message: "Parse error" });
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      return this.reply(null, { code: -32600, message: "Invalid Request" });
    }

    const { id, method, params } = msg as JsonRpcMessage;
    if (typeof method !== "string") {
      // A response to a server-initiated request; we never send any.
      if (id === undefined || id === null) this.reply(null, { code: -32600, message: "Invalid Request" });
      return;
    }
    if (id === undefined || id === null) {
      this.logger.debug(`notification: ${method}`);
      return;
    }

    this.logger.debug(`request: ${method} (id=${id})`);
    try {
      const result = await this.handleRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      if (err instanceof RpcError) this.reply(id, { code: err.code, message: err.message });
      else this.reply(id, { code: -32603, message: `Internal error: ${(err as Error).message}` });
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: SERVER_INFO,
          instructions: `Tools are discovered on demand. Use ${SEARCH_TOOL} to find a tool, then ${INVOKE_TOOL} to run it.`,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: META_TOOLS };
      case "tools/call":
        return this.callMetaTool(params);
      case "logging/setLevel":
        return this.forwardSetLevel(params);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async forwardSetLevel(params: unknown): Promise<unknown> {
    const targets = [...this.catalog.servers].filter(([, u]) => "logging" in u.capabilities);
    await Promise.allSettled(targets.map(([, u]) => u.supervisor.request("logging/setLevel", params)));
    return {};
  }

  private async callMetaTool(params: unknown): Promise<ToolResult> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string") throw new RpcError(-32602, "tools/call requires a string `name`");
    const input = (typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}) as Record<
      string,
      unknown
    >;

    switch (name) {
      case SEARCH_TOOL:
        return this.search(input);
      case INVOKE_TOOL:
        return this.invoke(input);
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}. Available tools: ${SEARCH_TOOL}, ${INVOKE_TOOL}`);
    }
  }

  private search(args: Record<string, unknown>): ToolResult {
    const { query, limit } = args;
    if (typeof query !== "string" || query.trim() === "") {
      return textResult("`query` must be a non-empty string", true);
    }
    const n =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.min(Math.max(Math.floor(limit), 1), MAX_SEARCH_LIMIT)
        : DEFAULT_SEARCH_LIMIT;

    const tools = this.catalog.search(query, n).map((t) => ({
      name: t.name,
      description: t.tool.description ?? "",
      inputSchema: t.tool.inputSchema ?? { type: "object" },
      score: Math.round(t.score * 1000) / 1000,
    }));
    return textResult(JSON.stringify({ query, count: tools.length, tools }, null, 2));
  }

  private async invoke(args: Record<string, unknown>): Promise<ToolResult> {
    const { tool_name: toolName, arguments: toolArgs } = args;
    if (typeof toolName !== "string" || toolName === "") {
      return textResult("`tool_name` must be a non-empty string", true);
    }
    if (toolArgs !== undefined && (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs))) {
      return textResult("`arguments` must be an object", true);
    }

    const entry = this.catalog.resolve(toolName);
    if (!entry) {
      const similar = this.catalog.search(toolName, 3).map((t) => t.name);
      const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
      return textResult(`Unknown tool "${toolName}".${hint} Use ${SEARCH_TOOL} to find available tools.`, true);
    }

    let res: JsonRpcMessage;
    try {
      res = await this.catalog.callTool(entry, (toolArgs ?? {}) as Record<string, unknown>, this.invokeTimeoutMs);
    } catch (err) {
      return textResult(`Upstream call to ${entry.name} failed: ${(err as Error).message}`, true);
    }
    if (res.error) {
      return textResult(`Upstream error from ${entry.name} (${res.error.code}): ${res.error.message}`, true);
    }
    return (res.result ?? { content: [] }) as ToolResult;
  }
}
