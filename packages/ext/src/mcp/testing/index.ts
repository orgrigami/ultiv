/** Test-only MCP fakes and rig, for other packages' tests (`@spreissen/ext/mcp-testing`). */
export { startHttpFake, type HttpFake } from "./http-fake.ts";
export { addLateTool } from "./fake-server.ts";
export { FAST_TUNING, makeRig, remoteInput, stdioInput, textOf, waitFor, type Rig } from "./rig.ts";
