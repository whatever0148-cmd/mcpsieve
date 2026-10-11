import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, connectUpstreams, loadConfig, parseConfig, type UpstreamCatalog } from "../src/config.js";

const mock = fileURLToPath(new URL("./fixtures/mock-mcp.mjs", import.meta.url));
let catalog: UpstreamCatalog | undefined;
afterEach(async () => {
  await catalog?.close();
  catalog = undefined;
});

describe("parseConfig", () => {
  it("parses the Claude Desktop shape", () => {
    const cfg = parseConfig({
      mcpServers: { fs: { command: "npx", args: ["-y", "server-fs", "/tmp"], env: { TOKEN: "x" } } },
    });
    expect(cfg.servers.fs).toEqual({ command: "npx", args: ["-y", "server-fs", "/tmp"], env: { TOKEN: "x" }, cwd: undefined });
  });

  it("parses Cursor-style entries, tolerating extra fields and defaulting args", () => {
    const cfg = parseConfig({ mcpServers: { a: { type: "stdio", command: "node", extra: 1 } } });
    expect(cfg.servers.a).toMatchObject({ command: "node", args: [] });
  });

  it("skips disabled and remote (url) servers, reporting why", () => {
    const cfg = parseConfig({
      mcpServers: { off: { command: "x", disabled: true }, remote: { url: "https://example.com/mcp" }, on: { command: "y" } },
    });
    expect(Object.keys(cfg.servers)).toEqual(["on"]);
    expect(cfg.skipped.map((s) => s.name)).toEqual(["off", "remote"]);
  });

  it("stringifies primitive env values", () => {
    const cfg = parseConfig({ mcpServers: { a: { command: "x", env: { PORT: 80, DEBUG: true } } } });
    expect(cfg.servers.a!.env).toEqual({ PORT: "80", DEBUG: "true" });
  });

  it.each([
    [null],
    [{}],
    [{ mcpServers: [] }],
    [{ mcpServers: { a: "nope" } }],
    [{ mcpServers: { a: {} } }],
    [{ mcpServers: { a: { command: "" } } }],
    [{ mcpServers: { a: { command: "x", args: [1] } } }],
    [{ mcpServers: { a: { command: "x", env: [] } } }],
    [{ mcpServers: { a: { command: "x", env: { K: {} } } } }],
    [{ mcpServers: { a: { command: "x", cwd: 5 } } }],
  ])("rejects invalid config %j", (raw) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("reads and parses a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpsieve-"));
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    expect(Object.keys((await loadConfig(path)).servers)).toEqual(["a"]);
  });

  it("reports missing files and invalid JSON as ConfigError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpsieve-"));
    await expect(loadConfig(join(dir, "missing.json"))).rejects.toThrow(/Cannot read/);
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{nope");
    await expect(loadConfig(bad)).rejects.toThrow(/not valid JSON/);
  });
});

describe("connectUpstreams", () => {
  const server = (set: string) => ({ command: process.execPath, args: [mock], env: { MOCK_SET: set } });

  it("starts every server and indexes all tools into one shared index", async () => {
    catalog = await connectUpstreams({ servers: { alpha: server("a"), beta: server("b") }, skipped: [] });
    expect(catalog.size).toBe(4);
    expect(catalog.index.size).toBe(4);
    expect(catalog.search("weather forecast", 1)[0]?.name).toBe("alpha__get_forecast");
    expect(catalog.search("email", 1)[0]?.name).toBe("beta__send_email");
  });

  it("indexes parameter names and descriptions too", async () => {
    catalog = await connectUpstreams({ servers: { beta: server("b") }, skipped: [] });
    expect(catalog.search("title", 1)[0]?.name).toBe("beta__create_issue");
  });

  it("resolves qualified names, and bare names only when unambiguous", async () => {
    catalog = await connectUpstreams({ servers: { alpha: server("a"), beta: server("a") }, skipped: [] });
    expect(catalog.resolve("alpha__get_weather")?.server).toBe("alpha");
    expect(catalog.resolve("get_weather")).toBeUndefined(); // exists on both servers
    expect(catalog.resolve("nope")).toBeUndefined();
  });

  it("skips servers that fail to start and warns", async () => {
    const warnings: string[] = [];
    catalog = await connectUpstreams(
      { servers: { good: server("a"), bad: { command: "definitely-not-a-binary-xyz", args: [] } }, skipped: [] },
      { logger: { debug() {}, warn: (m) => warnings.push(m) } },
    );
    expect([...catalog.servers.keys()]).toEqual(["good"]);
    expect(catalog.size).toBe(2);
    expect(warnings.some((w) => w.includes('"bad"'))).toBe(true);
  });
});
