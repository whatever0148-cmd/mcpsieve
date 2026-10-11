import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SubprocessSupervisor, type JsonRpcMessage } from "../src/supervisor.js";

const server = fileURLToPath(new URL("./fixtures/mock-server.mjs", import.meta.url));
const live: SubprocessSupervisor[] = [];

function make(env?: Record<string, string>, requestTimeoutMs?: number) {
  const sup = new SubprocessSupervisor({ command: process.execPath, args: [server], env, requestTimeoutMs });
  live.push(sup);
  sup.start();
  return sup;
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop(500)));
});

const once = <T extends unknown[]>(emitter: { once: (e: any, cb: (...a: T) => void) => unknown }, event: string) =>
  new Promise<T>((resolve) => emitter.once(event, (...args: T) => resolve(args)));

describe("SubprocessSupervisor", () => {
  it("spawns a process and reports running state", async () => {
    const sup = make();
    expect(sup.running).toBe(true);
    expect(sup.pid).toBeTypeOf("number");
    await sup.stop();
    expect(sup.running).toBe(false);
  });

  it("refuses to start twice", () => {
    const sup = make();
    expect(() => sup.start()).toThrow(/already started/);
  });

  it("round-trips a request over newline-delimited JSON-RPC", async () => {
    const sup = make();
    const res = await sup.request("echo", { hello: "world" });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.result).toEqual({ echoed: { hello: "world" } });
  });

  it("surfaces JSON-RPC error responses", async () => {
    const sup = make();
    const res = await sup.request("nope");
    expect(res.error?.code).toBe(-32601);
  });

  it("reassembles a message split across stdout chunks", async () => {
    const sup = make();
    const res = await sup.request("split");
    expect(res.result).toEqual({ ok: true });
  });

  it("handles multiple messages delivered in a single chunk", async () => {
    const sup = make();
    const seen: JsonRpcMessage[] = [];
    sup.on("message", (m) => seen.push(m));
    const res = await sup.request("burst");
    expect(res.result).toEqual({ burst: true });
    expect(seen.map((m) => m.method ?? "response")).toEqual(["notifications/a", "response"]);
  });

  it("emits parseError for non-JSON lines and keeps going", async () => {
    const sup = make();
    const errors: string[] = [];
    sup.on("parseError", (line) => errors.push(line));
    const res = await sup.request("garbage");
    expect(res.result).toEqual({});
    expect(errors).toEqual(["this is not json"]);
  });

  it("writes raw messages with an explicit id via send()", async () => {
    const sup = make();
    const reply = once<[JsonRpcMessage]>(sup, "message");
    sup.send({ jsonrpc: "2.0", id: "abc", method: "echo", params: [1] });
    const [msg] = await reply;
    expect(msg.id).toBe("abc");
    expect(msg.result).toEqual({ echoed: [1] });
  });

  it("times out requests that never get a response", async () => {
    const sup = make(undefined, 50);
    await expect(sup.request("silent")).rejects.toThrow(/timed out/);
  });

  it("rejects pending requests and emits exit when upstream dies", async () => {
    const sup = make();
    const exit = once<[number | null, string | null]>(sup, "exit");
    await expect(sup.request("die")).rejects.toThrow(/exited/);
    const [code] = await exit;
    expect(code).toBe(3);
    expect(sup.running).toBe(false);
    expect(() => sup.send({ jsonrpc: "2.0", method: "x" })).toThrow(/not running/);
  });

  it("emits an error when the command cannot be spawned", async () => {
    const sup = new SubprocessSupervisor({ command: "definitely-not-a-real-binary-xyz" });
    live.push(sup);
    const err = once<[Error]>(sup, "error");
    sup.start();
    const [e] = await err;
    expect(e.message).toMatch(/ENOENT/);
  });

  it("passes env vars to the child on top of process.env", async () => {
    const sup = make({ MOCK_PAGED: "1" });
    const tools = await sup.refreshTools();
    expect(tools).toHaveLength(5);
  });

  describe("tools/list interception", () => {
    it("caches tool declarations from upstream responses", async () => {
      const sup = make();
      expect(sup.hasToolCache).toBe(false);
      expect(sup.getTools()).toEqual([]);

      const emitted = once<[unknown[]]>(sup, "tools");
      const res = await sup.request("tools/list");
      const [fromEvent] = await emitted;

      expect(sup.hasToolCache).toBe(true);
      expect(sup.getTools().map((t) => t.name)).toEqual(["tool_0", "tool_1", "tool_2", "tool_3", "tool_4"]);
      expect(fromEvent).toHaveLength(5);
      expect(sup.getTool("tool_2")?.description).toBe("Mock tool number 2");
      // The original response is passed through unmodified.
      expect((res.result as { tools: unknown[] }).tools).toHaveLength(5);
    });

    it("intercepts tools/list sent via send() too", async () => {
      const sup = make();
      const tools = once<[unknown[]]>(sup, "tools");
      sup.send({ jsonrpc: "2.0", id: 99, method: "tools/list" });
      await tools;
      expect(sup.getTools()).toHaveLength(5);
    });

    it("merges paginated results via refreshTools()", async () => {
      const sup = make({ MOCK_PAGED: "1" });
      const tools = await sup.refreshTools();
      expect(tools.map((t) => t.name)).toEqual(["tool_0", "tool_1", "tool_2", "tool_3", "tool_4"]);
    });

    it("replaces the cache on a fresh (cursor-less) tools/list", async () => {
      const sup = make();
      await sup.request("tools/list");
      await sup.request("tools/list");
      expect(sup.getTools()).toHaveLength(5);
    });

    it("does not cache responses to other methods", async () => {
      const sup = make();
      await sup.request("echo", { tools: [{ name: "x" }] });
      expect(sup.getTools()).toEqual([]);
    });

    it("invalidates the cache flag on tools/list_changed", async () => {
      const sup = make();
      await sup.request("tools/list");
      expect(sup.hasToolCache).toBe(true);
      const changed = once<[]>(sup, "toolsChanged");
      await sup.request("changed");
      await changed;
      expect(sup.hasToolCache).toBe(false);
    });
  });
});
