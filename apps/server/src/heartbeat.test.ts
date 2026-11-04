/**
 * Heartbeats over real sockets: a client that answers pings stays, one that
 * has gone silent (half-open: asleep, network gone) is terminated on the
 * next beat, and the /push heartbeat frame reaches live clients.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import WebSocket, { WebSocketServer } from "ws";
import { beat, watchPongs } from "./heartbeat.ts";
import { liveHub } from "./live.ts";

const servers: WebSocketServer[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

const serverWithClient = async (autoPong: boolean) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  server.on("connection", watchPongs);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong });
  await new Promise<void>((resolve) => client.once("open", () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { server, client };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("socket heartbeat", () => {
  it("keeps a client that answers pings", async () => {
    const { server, client } = await serverWithClient(true);
    expect(beat(server)).toBe(0);
    await settle();
    expect(beat(server)).toBe(0);
    expect(server.clients.size).toBe(1);
    client.terminate();
  });

  it("terminates a client that stopped answering", async () => {
    const { server } = await serverWithClient(false);
    expect(beat(server)).toBe(0); // first ping goes out
    await settle();
    expect(beat(server)).toBe(1); // no pong came back: dropped
    await settle();
    expect(server.clients.size).toBe(0);
  });

  it("sends live clients a heartbeat frame they can see", async () => {
    const { server, client } = await serverWithClient(true);
    const [socket] = [...server.clients];
    liveHub.add(socket!);
    const frame = new Promise<string>((resolve) =>
      client.once("message", (data) => resolve(String(data))),
    );
    liveHub.heartbeat();
    expect(JSON.parse(await frame)).toMatchObject({ kind: "heartbeat" });
    client.terminate();
  });
});
