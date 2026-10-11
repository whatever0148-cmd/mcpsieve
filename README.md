# mcpsieve

**A stdio proxy that swaps your MCP servers' hundreds of tool schemas for two tiny meta-tools, so the model searches for the tool it needs instead of carrying all of them.**

## The problem

Every MCP tool you connect ships its name, description and JSON schema into the model's context on every conversation. Connect a handful of servers and **35k-50k tokens of tool definitions are loaded before your first prompt**: cost you pay on every request, context you can't use, and a longer menu for the model to pick wrongly from.

mcpsieve sits between your client and your servers. The client sees exactly two tools (about 215 tokens); the model finds the real tool by keyword and runs it through the proxy.

## Quickstart

```bash
# 1. See what your current setup costs (finds your Claude Code / Claude Desktop config)
npx mcpsieve audit

# 2. Put your servers behind mcpsieve (backs up your config first)
npx mcpsieve init

# 3. Or run it by hand against any MCP config file
npx mcpsieve run --config ./mcp.json
```

`init` never edits in place without a safety net: it writes a timestamped backup (`claude_desktop_config.backup-<timestamp>.json`), moves your stdio servers into `mcpsieve.config.json` next to your config, and replaces them with a single `mcpsieve` entry. Run `npx mcpsieve init --dry-run` to preview. Restart your client afterwards; to undo, copy the backup back.

## How it works

```
 ┌──────────────────┐   tools/list  →  2 tools     ┌──────────────────────────────────┐
 │   MCP client     │ ◄──────────────────────────  │            mcpsieve              │
 │ (Claude, Cursor) │                              │                                  │
 │                  │   mcp_sieve_search("...")    │   ┌─────────────────────────┐    │
 │                  │ ───────────────────────────► │   │ BM25 index of all tools │    │
 │                  │ ◄─ matching names + schemas  │   └─────────────────────────┘    │
 │                  │                              │                                  │
 │                  │   mcp_sieve_invoke(name,args)│   routes tools/call to the       │
 │                  │ ───────────────────────────► │   owning upstream                │
 └──────────────────┘     JSON-RPC over stdio      └───────┬──────────┬──────────┬────┘
                                                            │ stdio    │ stdio    │ stdio
                                                      ┌─────▼───┐ ┌────▼────┐ ┌───▼─────┐
                                                      │ github  │ │   fs    │ │  slack  │
                                                      │ 90 tools│ │ 12 tools│ │ 30 tools│
                                                      └─────────┘ └─────────┘ └─────────┘
```

1. At startup mcpsieve spawns each configured server, does the MCP handshake, and indexes every tool's name, description and parameter names with BM25.
2. `tools/list` returns only `mcp_sieve_search` and `mcp_sieve_invoke`.
3. The model calls `mcp_sieve_search` with keywords and gets back the best matches with their full input schemas, then calls `mcp_sieve_invoke` with a tool name (`<server>__<tool>`) and arguments. mcpsieve forwards the call upstream and returns the result unchanged.
4. Logging requests and `ping` are handled; stdout carries only JSON-RPC, and `--debug` logs go to stderr.

Zero runtime dependencies: only Node's standard library.

## Token benchmark

Run `npm run build && npm run benchmark` to reproduce. These figures use **synthetic** tools with a typical shape (a ~170-character description and 3-6 documented parameters, about 150 tokens each), not a measurement of any particular server; run `mcpsieve audit` on your own config for real numbers. Tokens are estimated at ~4 characters each.

| Tools | Without mcpsieve | With mcpsieve | Saved | Reduction | Search (median) |
|------:|-----------------:|--------------:|------:|----------:|----------------:|
| 25 | 3,965 | 215 | 3,750 | 94.6% | 0.002 ms |
| 50 | 7,702 | 215 | 7,487 | 97.2% | 0.003 ms |
| 100 | 15,114 | 215 | 14,899 | 98.6% | 0.004 ms |
| 200 | 30,498 | 215 | 30,283 | 99.3% | 0.007 ms |
| 400 | 60,925 | 215 | 60,710 | 99.6% | 0.016 ms |

The cost of mcpsieve is constant, so the more tools you have, the more you save. If your servers expose fewer tokens of schemas than mcpsieve's fixed ~215, `audit` says so instead of claiming savings.

Savings in tool-definition tokens are not free of trade-offs: the model spends one extra search call (and its results) to discover a tool, and answers depend on the search surfacing the right one.

## `mcpsieve audit`

```
+--------+-------+-------------------+-----------------+-----------+
| Server | Tools | Raw schema tokens | mcpsieve tokens | Savings % |
+--------+-------+-------------------+-----------------+-----------+
| github |    70 |            10,536 |               - |         - |
| fs     |    30 |             4,578 |               - |         - |
+--------+-------+-------------------+-----------------+-----------+
| Total  |   100 |            15,114 |             215 |     98.6% |
+--------+-------+-------------------+-----------------+-----------+

Saves 14,899 tokens (98.6% reduction)
Token counts are estimates (~4 characters per token).
```

(Output for the synthetic 100-tool catalog from the benchmark above, with server names added for illustration.) mcpsieve's cost is one fixed block shared by all servers, so it appears only on the Total row. `audit` exits 0 when it produced a report, and 1 if the config can't be read or every server fails to start.

## Commands

| Command | What it does |
|---|---|
| `mcpsieve run --config <path> [--debug]` | Serve the two-tool proxy on stdio |
| `mcpsieve audit [--config <path>] [--client <name>]` | Print the token comparison table |
| `mcpsieve init [--client <name>] [--config <path>] [--dry-run]` | Back up and wrap your client config |

`--client` is `claude-code` (the project's `.mcp.json`) or `claude-desktop`. With neither `--client` nor `--config`, mcpsieve looks for `.mcp.json` in the current directory, then the Claude Desktop config:

| OS | Claude Desktop config |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

For Cursor or anything else, pass `--config` explicitly.

## Config format

The standard `mcpServers` shape used by Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." } }
  }
}
```

Only stdio (`command`) servers are proxied. Remote `url` servers and entries marked `"disabled": true` are skipped, and `init` leaves remote servers in your client config.

## Requirements and development

Node.js 20 or newer.

```bash
npm ci
npm run build
npm test
```

## License

MIT
