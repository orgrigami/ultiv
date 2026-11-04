/**
 * Sensor source reads: an RSS item's seen-check and its fire record use one
 * key (an item without a guid or link used to re-fire every poll), and a
 * source is never buffered past the size cap.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { parseFeed } from "@spriessen/ext";
import { fetchSourceText, rssUidOf, SENSOR_MAX_BYTES } from "./sensors.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/small") {
      res.end("hello ü");
      return;
    }
    if (req.url === "/missing") {
      res.statusCode = 404;
      res.end();
      return;
    }
    // An endless page: chunks until the client goes away.
    const chunk = Buffer.alloc(256 * 1024, 97);
    const pump = (): void => {
      while (!res.destroyed && res.write(chunk));
      if (!res.destroyed) res.once("drain", pump);
    };
    res.on("close", () => res.destroy());
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("sensor sources", () => {
  it("keys an id-less RSS item the same way for the check and the record", () => {
    const [item] = parseFeed(
      "<rss><channel><item><title>Price drop</title>" +
        "<pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>",
    );
    expect(item?.uid).toBeNull();
    const key = rssUidOf(item!);
    expect(key).toBe(`Price drop@${Date.parse("Tue, 03 Nov 2026 10:00:00 GMT")}`);
    // A recorded key is found again on the next poll.
    expect([key].includes(rssUidOf(item!))).toBe(true);
    expect(rssUidOf({ uid: "guid-1", title: "x", pubAt: 1 })).toBe("guid-1");
  });

  it("reads a normal source and reports a failing one", async () => {
    expect(await fetchSourceText(`${base}/small`)).toBe("hello ü");
    await expect(fetchSourceText(`${base}/missing`)).rejects.toThrow("returned 404");
  });

  it("refuses a source past the cap instead of buffering it", async () => {
    await expect(fetchSourceText(`${base}/endless`)).rejects.toThrow(
      `larger than ${SENSOR_MAX_BYTES / 1024 / 1024} MB`,
    );
  });
});
