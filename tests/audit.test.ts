import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIEVE_TOKENS, buildAuditReport, estimateTokens, formatAuditReport, toolTokens } from "../src/audit.js";
import { main, type Io } from "../src/main.js";
import { defaultContext } from "../src/init.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDeclaration } from "../src/supervisor.js";

const mock = fileURLToPath(new URL("./fixtures/mock-mcp.mjs", import.meta.url));

const tool = (name: string, descLength: number): ToolDeclaration => ({
  name,
  description: "x".repeat(descLength),
  inputSchema: { type: "object" },
});

describe("estimateTokens", () => {
  it("uses ~4 characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("counts a tool as its serialized declaration", () => {
    const t = tool("t", 100);
    expect(toolTokens(t)).toBe(Math.ceil(JSON.stringify(t).length / 4));
  });
});

describe("mcpsieve fixed footprint", () => {
  it("stays under 350 tokens", () => {
    expect(SIEVE_TOKENS).toBeGreaterThan(0);
    expect(SIEVE_TOKENS).toBeLessThan(350);
  });
});

describe("buildAuditReport", () => {
  const report = buildAuditReport([
    { name: "github", tools: Array.from({ length: 50 }, (_, i) => tool(`t${i}`, 1000)) },
    { name: "slack", tools: Array.from({ length: 10 }, (_, i) => tool(`s${i}`, 400)) },
  ]);

  it("totals tools and tokens per server and overall", () => {
    const [github, slack] = report.servers;
    expect(github).toMatchObject({ name: "github", toolCount: 50 });
    expect(slack).toMatchObject({ name: "slack", toolCount: 10 });
    expect(github!.rawTokens).toBe(50 * toolTokens(tool("t0", 1000)));
    expect(report.totalTools).toBe(60);
    expect(report.rawTokens).toBe(github!.rawTokens + slack!.rawTokens);
  });

  it("computes savings against the fixed 2-tool footprint", () => {
    expect(report.sieveTokens).toBe(SIEVE_TOKENS);
    expect(report.savedTokens).toBe(report.rawTokens - SIEVE_TOKENS);
    expect(report.savingsPercent).toBeCloseTo((report.savedTokens / report.rawTokens) * 100, 10);
    expect(report.savingsPercent).toBeGreaterThan(98);
  });

  it("handles an empty catalog without dividing by zero", () => {
    const empty = buildAuditReport([]);
    expect(empty).toMatchObject({ totalTools: 0, rawTokens: 0, savingsPercent: 0 });
  });

  it("reports negative savings when the catalog is smaller than mcpsieve", () => {
    const tiny = buildAuditReport([{ name: "one", tools: [tool("a", 10)] }]);
    expect(tiny.savedTokens).toBeLessThan(0);
    expect(tiny.savingsPercent).toBeLessThan(0);
  });
});

describe("formatAuditReport", () => {
  const report = buildAuditReport([
    { name: "github", tools: Array.from({ length: 90 }, (_, i) => tool(`t${i}`, 1200)) },
    { name: "fs", tools: Array.from({ length: 12 }, (_, i) => tool(`f${i}`, 300)) },
  ]);
  const text = formatAuditReport(report);
  const lines = text.split("\n");

  it("renders an aligned ASCII table", () => {
    const tableLines = lines.filter((l) => l.startsWith("+") || l.startsWith("|"));
    expect(tableLines).toHaveLength(8); // 4 rules + header + 2 servers + total
    expect(new Set(tableLines.map((l) => l.length)).size).toBe(1);
    for (const l of tableLines) expect(l).toMatch(/^[+|].*[+|]$/);
  });

  it("has the required columns", () => {
    const header = lines.find((l) => l.includes("Server"))!;
    for (const col of ["Server", "Tools", "Raw schema tokens", "mcpsieve tokens", "Savings %"]) {
      expect(header).toContain(col);
    }
  });

  it("lists each server with comma-formatted numbers and a Total row", () => {
    const github = lines.find((l) => l.startsWith("| github"))!;
    expect(github).toContain(report.servers[0]!.rawTokens.toLocaleString("en-US"));
    expect(github).toMatch(/\| +90 \|/);
    const total = lines.find((l) => l.startsWith("| Total"))!;
    expect(total).toContain(report.rawTokens.toLocaleString("en-US"));
    expect(total).toContain(String(SIEVE_TOKENS));
    expect(total).toContain(`${report.savingsPercent.toFixed(1)}%`);
  });

  it("ends with the headline savings summary", () => {
    const saved = report.savedTokens.toLocaleString("en-US");
    expect(text).toContain(`Saves ${saved} tokens (${report.savingsPercent.toFixed(1)}% reduction)`);
  });

  it("is honest when there is nothing to save", () => {
    const tiny = formatAuditReport(buildAuditReport([{ name: "one", tools: [tool("a", 10)] }]));
    expect(tiny).toContain("No savings");
    expect(tiny).not.toContain("Saves");
    expect(formatAuditReport(buildAuditReport([]))).toContain("No tools found");
  });
});

describe("mcpsieve audit (CLI)", () => {
  async function runCli(servers: Record<string, unknown>, args: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), "mcpsieve-audit-"));
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: servers }));
    let stdout = "";
    let stderr = "";
    const io: Io = {
      stdout: { write: (s) => (stdout += s) },
      stderr: { write: (s) => (stderr += s) },
      ctx: { ...defaultContext(), cwd: dir },
    };
    const code = await main(["audit", "--config", configPath, ...args], io);
    return { code, stdout, stderr };
  }
  const server = (set: string) => ({ command: process.execPath, args: [mock], env: { MOCK_SET: set } });

  it("connects to upstreams, prints the table and exits 0", async () => {
    const { code, stdout, stderr } = await runCli({ alpha: server("a"), beta: server("b") });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/\| alpha +\| +2 \|/);
    expect(stdout).toMatch(/\| beta +\| +2 \|/);
    expect(stdout).toMatch(/\| Total +\| +4 \|/);
    expect(stdout).toContain("Token counts are estimates");
  });

  it("lists servers in config order", async () => {
    const { stdout } = await runCli({ zeta: server("a"), alpha: server("b") });
    expect(stdout.indexOf("| zeta")).toBeLessThan(stdout.indexOf("| alpha"));
  });

  it("still reports (exit 0) when some servers fail, warning on stderr", async () => {
    const { code, stdout, stderr } = await runCli({ good: server("a"), bad: { command: "no-such-binary-xyz" } });
    expect(code).toBe(0);
    expect(stdout).toContain("| good");
    expect(stdout).not.toContain("| bad");
    expect(stderr).toContain('Failed to start server "bad"');
  });

  it("exits 1 when every configured server fails", async () => {
    const { code } = await runCli({ bad: { command: "no-such-binary-xyz" } });
    expect(code).toBe(1);
  });

  it("exits 1 with a clear message for a missing config", async () => {
    const stderr: string[] = [];
    const code = await main(["audit", "--config", "/no/such/mcp.json"], {
      stdout: { write: () => undefined },
      stderr: { write: (s) => stderr.push(s) },
      ctx: defaultContext(),
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("Cannot read config file");
  });
});
