// Minimal newline-delimited JSON-RPC MCP server used by supervisor tests.
import { createInterface } from "node:readline";

const tools = Array.from({ length: 5 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Mock tool number ${i}`,
  inputSchema: { type: "object", properties: {} },
}));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  switch (msg.method) {
    case "tools/list": {
      const cursor = msg.params?.cursor;
      if (process.env.MOCK_PAGED === "1") {
        if (!cursor) send({ id: msg.id, result: { tools: tools.slice(0, 2), nextCursor: "p2" } });
        else send({ id: msg.id, result: { tools: tools.slice(2) } });
      } else {
        send({ id: msg.id, result: { tools } });
      }
      break;
    }
    case "echo":
      send({ id: msg.id, result: { echoed: msg.params } });
      break;
    case "garbage":
      process.stdout.write("this is not json\n");
      send({ id: msg.id, result: {} });
      break;
    case "split":
      // One message delivered in two chunks, plus two messages in one chunk.
      { const s = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        process.stdout.write(s.slice(0, 10));
        setTimeout(() => process.stdout.write(s.slice(10) + "\n"), 20); }
      break;
    case "burst":
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/a" }) + "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { burst: true } }) + "\n",
      );
      break;
    case "changed":
      send({ method: "notifications/tools/list_changed" });
      send({ id: msg.id, result: {} });
      break;
    case "silent":
      break;
    case "die":
      process.exit(3);
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
