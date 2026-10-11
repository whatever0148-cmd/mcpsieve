import { META_TOOLS } from "./proxy.js";
import type { ToolDeclaration } from "./supervisor.js";

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Tokens a client spends to advertise one tool (name, description and input schema as JSON). */
export function toolTokens(tool: ToolDeclaration): number {
  return estimateTokens(JSON.stringify(tool));
}

/** The fixed cost of mcpsieve's two meta-tools, regardless of how many upstream tools exist. */
export const SIEVE_TOKENS = estimateTokens(JSON.stringify(META_TOOLS));

export interface ServerAudit {
  name: string;
  toolCount: number;
  rawTokens: number;
}

export interface AuditReport {
  servers: ServerAudit[];
  totalTools: number;
  rawTokens: number;
  sieveTokens: number;
  savedTokens: number;
  /** 0-100, negative when mcpsieve would cost more than it saves. */
  savingsPercent: number;
}

export function buildAuditReport(servers: { name: string; tools: ToolDeclaration[] }[]): AuditReport {
  const rows = servers.map(({ name, tools }) => ({
    name,
    toolCount: tools.length,
    rawTokens: tools.reduce((sum, t) => sum + toolTokens(t), 0),
  }));
  const rawTokens = rows.reduce((sum, r) => sum + r.rawTokens, 0);
  const savedTokens = rawTokens - SIEVE_TOKENS;
  return {
    servers: rows,
    totalTools: rows.reduce((sum, r) => sum + r.toolCount, 0),
    rawTokens,
    sieveTokens: SIEVE_TOKENS,
    savedTokens,
    savingsPercent: rawTokens === 0 ? 0 : (savedTokens / rawTokens) * 100,
  };
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function formatAuditReport(report: AuditReport): string {
  const header = ["Server", "Tools", "Raw schema tokens", "mcpsieve tokens", "Savings %"];
  // mcpsieve's cost is one fixed block shared by all servers, so it only appears on the total row.
  const body = report.servers.map((s) => [s.name, fmt(s.toolCount), fmt(s.rawTokens), "-", "-"]);
  const total = [
    "Total",
    fmt(report.totalTools),
    fmt(report.rawTokens),
    fmt(report.sieveTokens),
    `${report.savingsPercent.toFixed(1)}%`,
  ];

  const widths = header.map((h, i) => Math.max(h.length, total[i]!.length, ...body.map((r) => r[i]!.length)));
  const rule = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const row = (cells: string[]) =>
    "| " + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(" | ") + " |";

  const lines = [rule, row(header), rule, ...body.map(row), rule, row(total), rule, ""];

  if (report.totalTools === 0) {
    lines.push("No tools found, nothing to save.");
  } else if (report.savedTokens > 0) {
    lines.push(`Saves ${fmt(report.savedTokens)} tokens (${report.savingsPercent.toFixed(1)}% reduction)`);
  } else {
    lines.push(
      `No savings: these tools cost ${fmt(report.rawTokens)} tokens, less than mcpsieve's fixed ${fmt(report.sieveTokens)}.`,
    );
  }
  lines.push("Token counts are estimates (~4 characters per token).");
  return lines.join("\n") + "\n";
}
