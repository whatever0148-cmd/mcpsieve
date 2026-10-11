import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectUpstreams } from "../src/config.js";
import { McpProxy } from "../src/proxy.js";
import type { JsonRpcMessage } from "../src/supervisor.js";

const mock = fileURLToPath(new URL("./fixtures/mock-mcp.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = (set: string) => ({ command: process.execPath, args: [mock], env: { MOCK_SET: set } });
const mockConfig = { mcpServers: { alpha: upstream("a"), beta: upstream("b") } };

/** Speaks newline-delimited JSON-RPC to anything exposing write/readline. */
class TestClient {
  private nextId = 1;
  private waiting = new Map<number, (m: JsonRpcMessage) => void>();
  readonly notifications: JsonRpcMessage[] = [];
  readonly lines: string[] = [];

  constructor(
    private readonly write: (line: string) => void,
    readable: NodeJS.ReadableStream,
  ) {
    createInterface({ input: readable }).on("line", (line) => {
      this.lines.push(line);
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (typeof msg.id === "number" && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)!(msg);
        this.waiting.delete(msg.id);
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 5000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown) {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  call(name: string, args?: unknown) {
    return this.request("tools/call", { name, arguments: args });
  }

  raw(line: string) {
    this.write(line + "\n");
  }
}

const textOf = (res: JsonRpcMessage) => (res.result as { content: { text: string }[] }).content[0]!.text;
const json = (res: JsonRpcMessage) => JSON.parse(textOf(res));

describe("McpProxy (in-process client -> proxy -> mock upstreams)", () => {
  let client: TestClient;
  let done: Promise<void>;
  let toProxy: PassThrough;

  beforeEach(async () => {
    const catalog = await connectUpstreams({ servers: mockConfig.mcpServers, skipped: [] });
    toProxy = new PassThrough();
    const fromProxy = new PassThrough();
    done = new McpProxy({ catalog, input: toProxy, output: fromProxy }).start();
    client = new TestClient((l) => toProxy.write(l), fromProxy);
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.error).toBeUndefined();
    client.notify("notifications/initialized");
  });

  afterEach(async () => {
    toProxy.end();
    await done;
  });

  it("negotiates initialize and advertises tools + logging", async () => {
    const res = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    expect(res.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "mcpsieve" },
      capabilities: { tools: {}, logging: {} },
    });
    const unknown = await client.request("initialize", { protocolVersion: "1999-01-01" });
    expect((unknown.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("answers ping locally", async () => {
    expect((await client.request("ping")).result).toEqual({});
  });

  it("tools/list returns exactly the two meta-tools", async () => {
    const res = await client.request("tools/list");
    const tools = (res.result as { tools: { name: string; inputSchema: any }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["mcp_sieve_search", "mcp_sieve_invoke"]);
    expect(tools[0]!.inputSchema.properties.limit).toMatchObject({ type: "number", default: 5 });
    expect(tools[0]!.inputSchema.required).toEqual(["query"]);
    expect(tools[1]!.inputSchema.properties.tool_name.type).toBe("string");
    expect(tools[1]!.inputSchema.properties.arguments.type).toBe("object");
  });

  describe("mcp_sieve_search", () => {
    it("finds upstream tools, with schemas, ranked by relevance", async () => {
      const out = json(await client.call("mcp_sieve_search", { query: "weather forecast" }));
      expect(out.count).toBe(2);
      expect(out.tools[0]).toMatchObject({
        name: "alpha__get_forecast",
        description: "Get a multi-day weather forecast for a city",
        inputSchema: { type: "object" },
      });
      expect(out.tools.map((t: any) => t.name)).toEqual(["alpha__get_forecast", "alpha__get_weather"]);
    });

    it("finds tools on other servers", async () => {
      const out = json(await client.call("mcp_sieve_search", { query: "create github issue" }));
      expect(out.tools[0].name).toBe("beta__create_issue");
    });

    it("honours limit and defaults it to 5", async () => {
      expect(json(await client.call("mcp_sieve_search", { query: "city email issue", limit: 1 })).count).toBe(1);
      expect(json(await client.call("mcp_sieve_search", { query: "get send create" })).count).toBeLessThanOrEqual(5);
    });

    it("returns an empty list when nothing matches", async () => {
      const res = await client.call("mcp_sieve_search", { query: "zebra" });
      expect(res.result).not.toHaveProperty("isError");
      expect(json(res)).toMatchObject({ count: 0, tools: [] });
    });

    it("reports a missing query as a tool error", async () => {
      const res = await client.call("mcp_sieve_search", {});
      expect(res.result).toMatchObject({ isError: true });
    });
  });

  describe("mcp_sieve_invoke", () => {
    it("proxies tools/call to the right upstream and returns its result", async () => {
      const res = await client.call("mcp_sieve_invoke", { tool_name: "alpha__get_weather", arguments: { city: "Oslo" } });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ content: [{ type: "text", text: "Sunny in Oslo [a]" }] });

      const other = await client.call("mcp_sieve_invoke", { tool_name: "beta__send_email", arguments: { to: "x@y.z" } });
      expect(textOf(other)).toBe('send_email ok {"to":"x@y.z"}');
    });

    it("accepts a bare tool name when unambiguous", async () => {
      const res = await client.call("mcp_sieve_invoke", { tool_name: "get_weather", arguments: { city: "Rome" } });
      expect(textOf(res)).toBe("Sunny in Rome [a]");
    });

    it("defaults arguments to an empty object", async () => {
      expect(textOf(await client.call("mcp_sieve_invoke", { tool_name: "get_forecast" }))).toBe("get_forecast ok {}");
    });

    it("passes through upstream tool-level errors", async () => {
      const res = await client.call("mcp_sieve_invoke", { tool_name: "create_issue", arguments: {} });
      expect(res.result).toEqual({ content: [{ type: "text", text: "title is required" }], isError: true });
    });

    it("suggests alternatives for unknown tools", async () => {
      const res = await client.call("mcp_sieve_invoke", { tool_name: "get_wether" });
      expect(res.result).toMatchObject({ isError: true });
      expect(textOf(res)).toContain("Unknown tool");
    });

    it("validates argument types", async () => {
      expect((await client.call("mcp_sieve_invoke", {})).result).toMatchObject({ isError: true });
      expect((await client.call("mcp_sieve_invoke", { tool_name: "get_weather", arguments: [] })).result).toMatchObject({
        isError: true,
      });
    });
  });

  describe("protocol edge cases", () => {
    it("rejects unknown methods with -32601", async () => {
      expect((await client.request("resources/list")).error?.code).toBe(-32601);
    });

    it("rejects calling an upstream tool name directly with -32602", async () => {
      expect((await client.call("alpha__get_weather", { city: "x" })).error?.code).toBe(-32602);
    });

    it("answers malformed input with parse / invalid-request errors and keeps serving", async () => {
      const seen = client.lines.length;
      client.raw("{not json");
      client.raw("[1,2]");
      await expect.poll(() => client.lines.length).toBe(seen + 2);
      expect(JSON.parse(client.lines[seen]!).error.code).toBe(-32700);
      expect(JSON.parse(client.lines[seen + 1]!).error.code).toBe(-32600);
      expect((await client.request("ping")).result).toEqual({});
    });

    it("forwards logging/setLevel upstream and relays upstream log notifications", async () => {
      expect((await client.request("logging/setLevel", { level: "debug" })).result).toEqual({});
      await expect.poll(() => client.notifications.length).toBe(2); // one per upstream
      expect(client.notifications.every((n) => n.method === "notifications/message")).toBe(true);
      expect(client.notifications.map((n) => (n.params as { data: string }).data)).toEqual(["level=debug", "level=debug"]);
    });

    it("shuts down upstreams when the client closes its input", async () => {
      toProxy.end();
      await done;
    });
  });
});

describe("mcpsieve CLI (real stdio process)", () => {
  let dir: string;
  let cli: string;
  let configPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcpsieve-cli-"));
    execFileSync("npx", ["tsup", "src/cli.ts", "--format", "esm", "--out-dir", dir, "--silent"], { cwd: root });
    cli = join(dir, "cli.js");
    configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify(mockConfig));
  }, 60_000);

  const run = (...args: string[]) => spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "pipe"] });

  it("serves JSON-RPC on stdout while --debug logs only to stderr", async () => {
    const child = run("run", "--config", configPath, "--debug");
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const client = new TestClient((l) => child.stdin.write(l), child.stdout);

    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(((await client.request("tools/list")).result as { tools: unknown[] }).tools).toHaveLength(2);
    expect(json(await client.call("mcp_sieve_search", { query: "send email" })).tools[0].name).toBe("beta__send_email");
    expect(textOf(await client.call("mcp_sieve_invoke", { tool_name: "alpha__get_weather", arguments: { city: "Oslo" } }))).toBe(
      "Sunny in Oslo [a]",
    );

    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(client.lines.length).toBeGreaterThan(0);
    for (const line of client.lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(stderr).toContain("debug: request: tools/list");
    expect(stderr).toContain("4 tools indexed from 2/2 servers");
  });

  it("does not emit debug logs without --debug", async () => {
    const child = run("run", "--config", configPath);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const client = new TestClient((l) => child.stdin.write(l), child.stdout);
    await client.request("ping");
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    expect(stderr).toBe("");
  });

  it.each([
    [[], 2, /Missing command/],
    [["run"], 2, /Missing required option --config/],
    [["bogus"], 2, /Unknown command/],
    [["run", "--nope"], 2, /nope/],
    [["run", "--config", "/no/such/file.json"], 1, /Cannot read config file/],
  ])("exits non-zero for bad invocation %j", async (args, expectedCode, pattern) => {
    const child = run(...args);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(expectedCode);
    expect(stderr).toMatch(pattern);
  });

  it("audit prints the token table on stdout and exits 0", async () => {
    const child = run("audit", "--config", configPath);
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    expect(await new Promise((r) => child.on("close", r))).toBe(0);
    expect(stdout).toContain("| alpha");
    expect(stdout).toContain("| beta");
    expect(stdout).toMatch(/\| Total\s+\| +4 \|/);
  });

  it("prints usage for --help", async () => {
    const child = run("--help");
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    expect(await new Promise((r) => child.on("close", r))).toBe(0);
    expect(stdout).toContain("mcpsieve run   --config");
    expect(stdout).toContain("mcpsieve audit");
    expect(stdout).toContain("mcpsieve init");
  });
});
