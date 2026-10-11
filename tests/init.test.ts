import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import {
  InitError,
  clientConfigPath,
  discoverConfig,
  initConfig,
  resolveSieveConfig,
  type Context,
} from "../src/init.js";
import { main } from "../src/main.js";

const ORIGINAL = {
  preferences: { theme: "dark" },
  mcpServers: {
    fs: { command: "npx", args: ["-y", "server-fs", "/tmp"] },
    github: { command: "node", args: ["gh.js"], env: { TOKEN: "secret" } },
    remote: { url: "https://example.com/mcp" },
  },
};

let dir: string;
let ctx: Context;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcpsieve-init-"));
  ctx = { cwd: join(dir, "project"), platform: "darwin", home: join(dir, "home"), env: {} };
  await mkdir(ctx.cwd, { recursive: true });
  configPath = join(ctx.cwd, ".mcp.json");
  await writeFile(configPath, JSON.stringify(ORIGINAL, null, 2));
});

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));

describe("clientConfigPath", () => {
  const base = { cwd: "/proj", home: "/home/u", env: {} };
  it("resolves Claude Desktop per platform", () => {
    expect(clientConfigPath("claude-desktop", { ...base, platform: "darwin" })).toBe(
      "/home/u/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(clientConfigPath("claude-desktop", { ...base, platform: "linux" })).toBe(
      "/home/u/.config/Claude/claude_desktop_config.json",
    );
    expect(clientConfigPath("claude-desktop", { ...base, platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })).toBe(
      "/xdg/Claude/claude_desktop_config.json",
    );
    expect(clientConfigPath("claude-desktop", { ...base, platform: "win32", env: { APPDATA: "C:\\A" } })).toMatch(
      /Claude.claude_desktop_config\.json$/,
    );
  });

  it("uses the project .mcp.json for Claude Code", () => {
    expect(clientConfigPath("claude-code", { ...base, platform: "linux" })).toBe("/proj/.mcp.json");
  });
});

describe("discoverConfig", () => {
  it("prefers the project .mcp.json, then Claude Desktop", async () => {
    expect(await discoverConfig(ctx)).toBe(configPath);
    const desktop = clientConfigPath("claude-desktop", ctx);
    await mkdir(join(desktop, ".."), { recursive: true });
    await writeFile(desktop, "{}");
    expect(await discoverConfig(ctx)).toBe(configPath);
    expect(await discoverConfig(ctx, "claude-desktop")).toBe(desktop);
  });

  it("falls back to Claude Desktop when there is no project config", async () => {
    const empty = { ...ctx, cwd: join(dir, "empty") };
    const desktop = clientConfigPath("claude-desktop", empty);
    await mkdir(join(desktop, ".."), { recursive: true });
    await writeFile(desktop, "{}");
    expect(await discoverConfig(empty)).toBe(desktop);
  });

  it("explains where it looked when nothing exists", async () => {
    await expect(discoverConfig({ ...ctx, cwd: join(dir, "nowhere") })).rejects.toThrow(/No MCP config found[\s\S]*--config/);
  });
});

describe("initConfig", () => {
  it("wraps stdio servers behind `mcpsieve run`, keeping everything else", async () => {
    const result = await initConfig({ ctx, now: new Date("2026-10-10T12:00:00.123Z") });
    expect(result).toMatchObject({ status: "initialized", wrapped: ["fs", "github"], kept: ["remote"] });

    const sievePath = join(ctx.cwd, "mcpsieve.config.json");
    expect(result.sieveConfigPath).toBe(sievePath);

    const updated = await readJson(configPath);
    expect(updated.preferences).toEqual({ theme: "dark" });
    expect(Object.keys(updated.mcpServers)).toEqual(["remote", "mcpsieve"]);
    expect(updated.mcpServers.remote).toEqual(ORIGINAL.mcpServers.remote);
    expect(updated.mcpServers.mcpsieve).toEqual({
      command: "npx",
      args: ["-y", "mcpsieve", "run", "--config", sievePath],
    });

    const moved = parseConfig(await readJson(sievePath));
    expect(Object.keys(moved.servers)).toEqual(["fs", "github"]);
    expect(moved.servers.github!.env).toEqual({ TOKEN: "secret" });
  });

  it("writes a timestamped backup identical to the original", async () => {
    const before = await readFile(configPath, "utf8");
    const result = await initConfig({ ctx, now: new Date("2026-10-10T12:00:00.123Z") });
    expect(result.backupPath).toBe(join(ctx.cwd, ".mcp.backup-2026-10-10T12-00-00-123Z.json"));
    expect(await readFile(result.backupPath!, "utf8")).toBe(before);
  });

  it("keeps the secrets file private and the client config's mode", async () => {
    if (process.platform === "win32") return;
    const result = await initConfig({ ctx });
    expect((await stat(result.sieveConfigPath!)).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: a second run changes nothing and makes no new backup", async () => {
    await initConfig({ ctx });
    const after = await readFile(configPath, "utf8");
    const files = await readdir(ctx.cwd);

    const again = await initConfig({ ctx });
    expect(again.status).toBe("already-initialized");
    expect(await readFile(configPath, "utf8")).toBe(after);
    expect(await readdir(ctx.cwd)).toEqual(files);
  });

  it("--dry-run reports the plan without touching the disk", async () => {
    const before = await readFile(configPath, "utf8");
    const files = await readdir(ctx.cwd);
    const result = await initConfig({ ctx, dryRun: true });
    expect(result).toMatchObject({ status: "initialized", dryRun: true, wrapped: ["fs", "github"] });
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await readdir(ctx.cwd)).toEqual(files);
  });

  it("leaves an unparseable config untouched", async () => {
    await writeFile(configPath, "{ not json");
    await expect(initConfig({ ctx })).rejects.toThrow(InitError);
    expect(await readFile(configPath, "utf8")).toBe("{ not json");
    expect(await readdir(ctx.cwd)).toEqual([".mcp.json"]);
  });

  it("refuses to overwrite an existing mcpsieve.config.json", async () => {
    await writeFile(join(ctx.cwd, "mcpsieve.config.json"), "precious");
    await expect(initConfig({ ctx })).rejects.toThrow(/refusing to overwrite/);
    expect(await readFile(join(ctx.cwd, "mcpsieve.config.json"), "utf8")).toBe("precious");
    expect((await readdir(ctx.cwd)).some((f) => f.includes("backup"))).toBe(false);
  });

  it("refuses when an unrelated server is already named mcpsieve", async () => {
    await writeFile(configPath, JSON.stringify({ mcpServers: { mcpsieve: { command: "other" }, a: { command: "x" } } }));
    await expect(initConfig({ ctx })).rejects.toThrow(/unrelated server named "mcpsieve"/);
  });

  it("does nothing when there are no stdio servers", async () => {
    await writeFile(configPath, JSON.stringify({ mcpServers: { remote: { url: "https://x" } } }));
    expect((await initConfig({ ctx })).status).toBe("nothing-to-wrap");
    expect(await readdir(ctx.cwd)).toEqual([".mcp.json"]);
  });

  it("requires an mcpServers object", async () => {
    await writeFile(configPath, "{}");
    await expect(initConfig({ ctx })).rejects.toThrow(/no "mcpServers"/);
  });

  it("accepts an explicit --config path", async () => {
    const custom = join(dir, "custom.json");
    await writeFile(custom, JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    const result = await initConfig({ ctx, configPath: custom });
    expect(result.sieveConfigPath).toBe(join(dir, "mcpsieve.config.json"));
  });
});

describe("resolveSieveConfig", () => {
  it("returns the client config before init and the real server list after", async () => {
    expect(await resolveSieveConfig(ctx)).toBe(configPath);
    await initConfig({ ctx });
    expect(await resolveSieveConfig(ctx)).toBe(join(ctx.cwd, "mcpsieve.config.json"));
  });
});

describe("mcpsieve init (CLI)", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, ctx } };
  };

  it("initialises, prints a summary, and exits 0", async () => {
    const { out, err, io } = capture();
    expect(await main(["init", "--client", "claude-code"], io)).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("");
    expect(text).toContain("Backed up");
    expect(text).toContain("fs, github");
    expect(text).toContain("Restart your MCP client");
  });

  it("supports --dry-run", async () => {
    const { out, io } = capture();
    expect(await main(["init", "--dry-run"], io)).toBe(0);
    expect(out.join("")).toContain("Dry run");
    expect((await readdir(ctx.cwd)).sort()).toEqual([".mcp.json"]);
  });

  it("rejects an unknown --client with a usage error", async () => {
    const { err, io } = capture();
    expect(await main(["init", "--client", "vim"], io)).toBe(2);
    expect(err.join("")).toContain('Unknown client "vim"');
  });

  it("exits 1 with a readable message when no config exists", async () => {
    const { err, io } = capture();
    io.ctx = { ...ctx, cwd: join(dir, "nowhere") };
    expect(await main(["init"], io)).toBe(1);
    expect(err.join("")).toContain("No MCP config found");
  });
});
