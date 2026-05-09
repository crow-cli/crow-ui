import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";
const WS_URL = "ws://localhost:3928/ws";
const WS_ACP_URL = "ws://localhost:3928/ws/acp";

function wsInvoke(
  ws: WebSocket,
  method: string,
  params: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const onMessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener("message", onMessage);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch {}
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", () => reject(new Error("closed")), {
      once: true,
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

test.describe("WebSocket Endpoint Split", () => {
  test("/ws accepts app methods and rejects ACP methods", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WS connect failed"));
    });

    // App method should work
    const settings = await wsInvoke(ws, "get_all_settings", {});
    expect(settings).toBeDefined();
    expect(typeof settings).toBe("object");

    // ACP method should fail (not routed on /ws)
    try {
      await wsInvoke(ws, "acp_spawn", { cmd: "echo", args: ["hi"] });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("unknown method");
    }

    ws.close();
  });

  test("/ws/acp accepts ACP methods", async () => {
    const ws = new WebSocket(WS_ACP_URL);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WS ACP connect failed"));
    });

    // ACP spawn should be accepted (we won't actually spawn, just verify routing)
    // acp_spawn returns an error about missing params if params are wrong,
    // but "unknown method" means it's routed to the wrong endpoint
    try {
      await wsInvoke(ws, "acp_spawn", { cmd: "echo", args: ["hi"] });
    } catch (e: any) {
      // Expected — params are wrong, but method IS known
      expect(e.message).not.toContain("unknown method");
    }

    // App method should fail on ACP endpoint
    try {
      await wsInvoke(ws, "get_all_settings", {});
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/unknown method|unknown ACP method/);
    }

    ws.close();
  });
});
