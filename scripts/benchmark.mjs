// Reproduces the README benchmark: node scripts/benchmark.mjs  (run `npm run build` first)
import { BM25Index, SIEVE_TOKENS, buildAuditReport, estimateTokens, formatAuditReport, toolTokens } from "../dist/index.js";

// Deterministic PRNG so the table is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const verbs = ["create", "list", "get", "update", "delete", "search", "send", "archive", "merge", "export"];
const nouns = ["issue", "file", "email", "branch", "commit", "event", "message", "table", "user", "report", "page", "ticket"];
const params = [
  ["id", "string", "Unique identifier of the resource"],
  ["query", "string", "Free-text filter applied to the results"],
  ["limit", "number", "Maximum number of items to return"],
  ["cursor", "string", "Pagination cursor from a previous response"],
  ["name", "string", "Human-readable name"],
  ["owner", "string", "Account or organisation that owns the resource"],
  ["include_archived", "boolean", "Whether archived items are included"],
];

function makeTool(i) {
  const verb = pick(verbs);
  const noun = pick(nouns);
  const chosen = [...params].sort(() => rand() - 0.5).slice(0, 3 + Math.floor(rand() * 4));
  return {
    name: `${verb}_${noun}_${i}`,
    description: `${verb[0].toUpperCase()}${verb.slice(1)} a ${noun} in the connected service. Supports filtering and pagination, and returns the matching ${noun} records with their metadata.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(chosen.map(([k, type, description]) => [k, { type, description }])),
      required: [chosen[0][0]],
    },
  };
}

const rows = [];
for (const n of [25, 50, 100, 200, 400]) {
  seed = 42;
  const tools = Array.from({ length: n }, (_, i) => makeTool(i));
  const raw = tools.reduce((sum, t) => sum + toolTokens(t), 0);

  const index = new BM25Index();
  for (const t of tools) index.addDocument(t.name, `${t.name} ${t.description} ${Object.keys(t.inputSchema.properties).join(" ")}`);
  const queries = ["create issue", "search email message", "export report", "update ticket", "list branch commit"];
  for (let i = 0; i < 200; i++) index.search(queries[i % queries.length], 5); // warm up
  const times = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    index.search(queries[i % queries.length], 5);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);

  rows.push({ n, raw, saved: raw - SIEVE_TOKENS, pct: ((raw - SIEVE_TOKENS) / raw) * 100, ms: times[100] });
}

const f = (x) => x.toLocaleString("en-US");
console.log("| Tools | Without mcpsieve | With mcpsieve | Saved | Reduction | Search (median) |");
console.log("|------:|-----------------:|--------------:|------:|----------:|----------------:|");
for (const r of rows) {
  console.log(`| ${r.n} | ${f(r.raw)} | ${f(SIEVE_TOKENS)} | ${f(r.saved)} | ${r.pct.toFixed(1)}% | ${r.ms.toFixed(3)} ms |`);
}
console.log(`\nAverage ${Math.round(rows[2].raw / rows[2].n)} tokens/tool; token counts via ${estimateTokens.name}() at ~4 chars/token.`);

// Sample `audit` output for the 100-tool catalog split across two servers.
seed = 42;
const sample = Array.from({ length: 100 }, (_, i) => makeTool(i));
console.log("\n" + formatAuditReport(buildAuditReport([
  { name: "github", tools: sample.slice(0, 70) },
  { name: "fs", tools: sample.slice(70) },
])));
