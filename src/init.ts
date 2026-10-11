import { constants } from "node:fs";
import { copyFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ClientName = "claude-code" | "claude-desktop";
export const CLIENTS: readonly ClientName[] = ["claude-code", "claude-desktop"];

export const WRAPPER_NAME = "mcpsieve";
export const SIEVE_CONFIG_NAME = "mcpsieve.config.json";

export interface Context {
  cwd: string;
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

export const defaultContext = (): Context => ({
  cwd: process.cwd(),
  platform: process.platform,
  home: homedir(),
  env: process.env,
});

export class InitError extends Error {
  override name = "InitError";
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where a client keeps its MCP config. Claude Code uses the project's `.mcp.json`. */
export function clientConfigPath(client: ClientName, ctx: Context): string {
  if (client === "claude-code") return join(ctx.cwd, ".mcp.json");
  switch (ctx.platform) {
    case "darwin":
      return join(ctx.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Find the first existing client config: project `.mcp.json`, then Claude Desktop. */
export async function discoverConfig(ctx: Context, client?: ClientName): Promise<string> {
  const candidates = (client ? [client] : CLIENTS).map((c) => clientConfigPath(c, ctx));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new InitError(
    `No MCP config found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}\nPass --config <path> to point at one.`,
  );
}

async function readJson(path: string): Promise<Json> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new InitError(`Cannot read ${path} as JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new InitError(`${path} must contain a JSON object`);
  return parsed;
}

/** True when `entry` is the `mcpsieve run --config <file>` wrapper that init writes. */
function wrapperConfigArg(entry: unknown): string | undefined {
  if (!isRecord(entry) || !Array.isArray(entry.args)) return undefined;
  const args = entry.args as unknown[];
  const run = args.indexOf("run");
  const flag = args.indexOf("--config");
  if (run === -1 || flag === -1 || typeof args[flag + 1] !== "string") return undefined;
  return args[flag + 1] as string;
}

/** The config `mcpsieve audit` should read: follows a wrapper entry to the real server list. */
export async function resolveSieveConfig(ctx: Context, client?: ClientName): Promise<string> {
  const path = await discoverConfig(ctx, client);
  const servers = (await readJson(path)).mcpServers;
  const target = isRecord(servers) ? wrapperConfigArg(servers[WRAPPER_NAME]) : undefined;
  return target ? resolve(dirname(path), target) : path;
}

export interface InitOptions {
  ctx: Context;
  client?: ClientName;
  configPath?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface InitResult {
  status: "initialized" | "already-initialized" | "nothing-to-wrap";
  clientConfigPath: string;
  sieveConfigPath?: string;
  backupPath?: string;
  /** Servers moved behind mcpsieve. */
  wrapped: string[];
  /** Servers left in the client config because mcpsieve can't proxy them (e.g. remote URLs). */
  kept: string[];
  dryRun: boolean;
}

async function writeAtomic(path: string, data: string, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Move a client's stdio servers into mcpsieve.config.json and point the client at `mcpsieve run`. */
export async function initConfig(options: InitOptions): Promise<InitResult> {
  const { ctx, dryRun = false } = options;
  const clientPath = options.configPath
    ? resolve(ctx.cwd, options.configPath)
    : await discoverConfig(ctx, options.client);
  const config = await readJson(clientPath);

  if (!isRecord(config.mcpServers)) throw new InitError(`${clientPath} has no "mcpServers" object`);
  const servers = config.mcpServers;
  const base = { clientConfigPath: clientPath, wrapped: [], kept: [], dryRun };

  if (wrapperConfigArg(servers[WRAPPER_NAME])) return { ...base, status: "already-initialized" };
  if (WRAPPER_NAME in servers) {
    throw new InitError(`An unrelated server named "${WRAPPER_NAME}" already exists in ${clientPath}; rename it first`);
  }

  const moved: Json = {};
  const kept: Json = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (isRecord(entry) && typeof entry.command === "string") moved[name] = entry;
    else kept[name] = entry;
  }
  if (Object.keys(moved).length === 0) {
    return { ...base, status: "nothing-to-wrap", kept: Object.keys(kept) };
  }

  const sievePath = join(dirname(clientPath), SIEVE_CONFIG_NAME);
  if (await exists(sievePath)) {
    throw new InitError(`${sievePath} already exists; refusing to overwrite it. Move it away and re-run.`);
  }

  const wrapper = { command: "npx", args: ["-y", "mcpsieve", "run", "--config", sievePath] };
  const updated = { ...config, mcpServers: { ...kept, [WRAPPER_NAME]: wrapper } };

  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dirname(clientPath), `${basename(clientPath, ".json")}.backup-${stamp}.json`);
  const result: InitResult = {
    status: "initialized",
    clientConfigPath: clientPath,
    sieveConfigPath: sievePath,
    backupPath,
    wrapped: Object.keys(moved),
    kept: Object.keys(kept),
    dryRun,
  };
  if (dryRun) return result;

  const mode = (await stat(clientPath)).mode & 0o777;
  await copyFile(clientPath, backupPath, constants.COPYFILE_EXCL);
  // The moved entries may carry secrets in `env`, so keep the new file private.
  await writeFile(sievePath, JSON.stringify({ mcpServers: moved }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    await writeAtomic(clientPath, JSON.stringify(updated, null, 2) + "\n", mode);
  } catch (err) {
    await unlink(sievePath).catch(() => undefined);
    throw err;
  }
  return result;
}
