import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { buildAuditReport, formatAuditReport } from "./audit.js";
import { ConfigError, connectUpstreams, loadConfig, type Logger } from "./config.js";
import {
  CLIENTS,
  InitError,
  defaultContext,
  initConfig,
  resolveSieveConfig,
  type ClientName,
  type Context,
} from "./init.js";
import { McpProxy } from "./proxy.js";

const USAGE = `mcpsieve - search-and-invoke proxy for MCP servers

Usage:
  mcpsieve run   --config <path> [--debug]
  mcpsieve audit [--config <path>] [--client <name>] [--debug]
  mcpsieve init  [--client <name>] [--config <path>] [--dry-run]

Commands:
  run     Serve the two-tool proxy on stdio in front of the configured servers
  audit   Estimate how many tokens the configured servers' tool schemas cost
  init    Back up your MCP client config and put its servers behind mcpsieve

Options:
  -c, --config <path>  MCP config file ({ "mcpServers": { ... } })
      --client <name>  claude-code | claude-desktop (where to look for a config)
      --dry-run        init: show what would change without writing anything
  -d, --debug          Log to stderr (stdout stays reserved for JSON-RPC)
  -h, --help           Show this help
`;

export interface Io {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  ctx: Context;
}

const options = {
  config: { type: "string", short: "c" },
  client: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  debug: { type: "boolean", short: "d", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

export async function main(
  argv: string[],
  io: Io = { stdout: process.stdout, stderr: process.stderr, ctx: defaultContext() },
): Promise<number> {
  const usageError = (message: string) => {
    io.stderr.write(`${message}\n\n${USAGE}`);
    return 2;
  };

  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (err) {
    return usageError((err as Error).message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const command = positionals[0];
  if (!command) return usageError("Missing command");
  if (!["run", "audit", "init"].includes(command) || positionals.length > 1) {
    return usageError(`Unknown command: ${positionals.join(" ")}`);
  }

  const client = values.client as ClientName | undefined;
  if (client !== undefined && !CLIENTS.includes(client)) {
    return usageError(`Unknown client "${client}" (expected ${CLIENTS.join(" or ")})`);
  }
  if (command === "run" && !values.config) return usageError("Missing required option --config");

  const logger: Logger = {
    debug: (m) => values.debug && io.stderr.write(`[mcpsieve] debug: ${m}\n`),
    warn: (m) => io.stderr.write(`[mcpsieve] warn: ${m}\n`),
  };

  try {
    switch (command) {
      case "run":
        return await runProxy(resolve(values.config!), logger);
      case "audit":
        return await runAudit(values.config ? resolve(values.config) : await resolveSieveConfig(io.ctx, client), io, logger);
      default:
        return await runInit({ client, configPath: values.config, dryRun: values["dry-run"] }, io);
    }
  } catch (err) {
    const friendly = err instanceof ConfigError || err instanceof InitError;
    io.stderr.write(`mcpsieve: ${friendly ? err.message : (err as Error).stack}\n`);
    return 1;
  }
}

async function runProxy(configPath: string, logger: Logger): Promise<number> {
  const catalog = await connectUpstreams(await loadConfig(configPath), { logger });
  const proxy = new McpProxy({ catalog, logger });
  const shutdown = () => proxy.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  logger.debug("ready, serving on stdio");
  await proxy.start();
  return 0;
}

async function runAudit(configPath: string, io: Io, logger: Logger): Promise<number> {
  const config = await loadConfig(configPath);
  const names = Object.keys(config.servers);
  const catalog = await connectUpstreams(config, { logger });
  try {
    const connected = names.flatMap((name) => {
      const upstream = catalog.servers.get(name);
      return upstream ? [{ name, tools: upstream.supervisor.getTools() }] : [];
    });
    io.stdout.write(formatAuditReport(buildAuditReport(connected)));
    // A config where every server failed is a failed audit; a partial result still reports.
    return names.length > 0 && connected.length === 0 ? 1 : 0;
  } finally {
    await catalog.close();
  }
}

async function runInit(opts: { client?: ClientName; configPath?: string; dryRun: boolean }, io: Io): Promise<number> {
  const result = await initConfig({ ctx: io.ctx, ...opts });
  const out = (s: string) => io.stdout.write(s + "\n");

  if (result.status === "already-initialized") {
    out(`${result.clientConfigPath} already runs through mcpsieve; nothing to do.`);
  } else if (result.status === "nothing-to-wrap") {
    out(`${result.clientConfigPath} has no stdio servers to wrap; nothing to do.`);
  } else {
    const [backup, write, update] = result.dryRun ? ["Would back up", "Would write", "Would update"] : ["Backed up", "Wrote", "Updated"];
    if (result.dryRun) out("Dry run: no files were changed.");
    out(`${backup}  ${result.clientConfigPath} -> ${result.backupPath}`);
    out(`${write}  ${result.sieveConfigPath} (${result.wrapped.length} servers: ${result.wrapped.join(", ")})`);
    out(`${update}  ${result.clientConfigPath} to run "npx -y mcpsieve run --config ${result.sieveConfigPath}"`);
    if (result.kept.length) out(`Left untouched (not stdio): ${result.kept.join(", ")}`);
    if (!result.dryRun) out("\nRestart your MCP client to pick this up. To undo, copy the backup over the config.");
  }
  return 0;
}
