/**
 * Test-only stdio MCP server, run as `node stdio-server.ts`. `whoami` reports
 * FAKE_TOKEN (redaction), `crash` exits (reconnect), and it reports whether a
 * host variable leaked through the scrubbed environment.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { makeFakeServer } from "./fake-server.ts";

const server = makeFakeServer({ whoami: () => process.env.FAKE_TOKEN ?? "no token" });
const noArgs = fromJsonSchema<Record<string, never>>({ type: "object", properties: {} });
server.registerTool("crash", { description: "Exit now.", inputSchema: noArgs }, async () => {
  setTimeout(() => process.exit(3), 10);
  return { content: [{ type: "text" as const, text: "bye" }] };
});
server.registerTool(
  "env_leak",
  { description: "Host env check.", inputSchema: noArgs },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: `leak=${process.env.SPREISSEN_HOST_SECRET ?? "none"} cwd=${process.cwd()}`,
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
