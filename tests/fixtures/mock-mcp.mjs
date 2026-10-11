// A small but protocol-correct MCP server. MOCK_SET selects which tools it offers.
import { createInterface } from "node:readline";

const set = process.env.MOCK_SET ?? "a";
const schema = (props, required = []) => ({ type: "object", properties: props, required });
const sets = {
  a: [
    { name: "get_weather", description: "Get the current weather for a city", inputSchema: schema({ city: { type: "string", description: "City name" } }, ["city"]) },
    { name: "get_forecast", description: "Get a multi-day weather forecast for a city", inputSchema: schema({ city: { type: "string" }, days: { type: "number" } }, ["city"]) },
  ],
  b: [
    { name: "send_email", description: "Send an email message to a recipient", inputSchema: schema({ to: { type: "string" }, body: { type: "string" } }, ["to"]) },
    { name: "create_issue", description: "Create a new issue in a GitHub repository", inputSchema: schema({ title: { type: "string", description: "Issue title" } }, ["title"]) },
  ],
};
const tools = sets[set];

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError && { isError }) });

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true }, logging: {} },
        serverInfo: { name: `mock-${set}`, version: "1.0.0" },
      } });
      break;
    case "ping":
      send({ id: msg.id, result: {} });
      break;
    case "tools/list":
      send({ id: msg.id, result: { tools } });
      break;
    case "logging/setLevel":
      send({ method: "notifications/message", params: { level: "info", logger: `mock-${set}`, data: `level=${msg.params?.level}` } });
      send({ id: msg.id, result: {} });
      break;
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (!tools.some((t) => t.name === name)) {
        send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      } else if (name === "create_issue" && !args.title) {
        send({ id: msg.id, result: text("title is required", true) });
      } else if (name === "get_weather") {
        send({ id: msg.id, result: text(`Sunny in ${args.city} [${set}]`) });
      } else {
        send({ id: msg.id, result: text(`${name} ok ${JSON.stringify(args)}`) });
      }
      break;
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
