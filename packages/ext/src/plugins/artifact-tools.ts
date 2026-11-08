/**
 * The model-facing artifact tools over a bot's files: artifact_write (by
 * path, into the same tree bash and the file tools use; a taken path is
 * replaced in place), artifact_read, artifact_list and the gated
 * artifact_delete. The store itself is artifacts.ts; paths go through
 * fs/tree.ts.
 */
import { arr, bool, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { ArtifactInfoSchema } from "@spriessen/contracts";
import type { ArtifactInfo } from "@spriessen/contracts";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { putFile, removeFile } from "../fs/tree.ts";
import { treePath } from "../fs/tree-path.ts";
import {
  artifactsDir,
  MAX_IMAGE_BASE64,
  readArtifact,
  readArtifactBytes,
  readArtifactInfo,
  searchArtifacts,
  VISION_MIMES,
  type ArtifactsOptions,
} from "./artifacts.ts";
import { scopeDir, type ScopeHolder } from "./vault.ts";

const MAX_WRITE_CHARS = 1_000_000;

const WriteParams = obj(
  {
    name: str({
      description:
        'Where the file goes in your files, e.g. "report.md" or "reports/board.md"; the ' +
        "extension sets the type. Writing a path that exists replaces that file.",
    }),
    content: str({
      description: `The file's UTF-8 content, up to ${MAX_WRITE_CHARS} chars.`,
    }),
  },
  { open: true },
);

const fail = (text: string) => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

const artifactWriteTool = (dirOf: (conversationId: string) => string, holder?: ScopeHolder): Tool =>
  defineTool({
    name: "artifact_write",
    description:
      "Write a file into your files, the same tree bash sees under /home and file_read reads: " +
      "reports, data, code, anything your owner should keep. Writing to a path that already " +
      "exists REPLACES that file in place (same id, so its cards and links show the new " +
      "content; the earlier version is kept for your owner); use a new path for a separate " +
      "file. The owner sees a file card with preview and download in the chat for every " +
      "write; to share a file made earlier (by you or bash), link it in your reply as a " +
      "markdown link, [name](/api/artifacts/<id>); a bare path in plain text shows no card.",
    parameters: WriteParams,
    structuredOutputSchema: obj(
      {
        id: str(),
        name: str(),
        path: str(),
        replaced: bool(),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      if (args.content.length > MAX_WRITE_CHARS)
        return fail(`content exceeds ${MAX_WRITE_CHARS} chars`);
      const parsed = treePath(args.name);
      if ("refused" in parsed) return fail(`refused: ${parsed.refused}`);
      const conversationId = String(api.conversationId);
      const scope = holder?.get()?.scopeOf(conversationId);
      const put = await putFile(dirOf(conversationId), parsed.path, Buffer.from(args.content), {
        conversationId,
        owner: scope?.owner ?? null,
        profile: scope?.profile ?? null,
      });
      if ("refused" in put) return fail(`refused: ${put.refused}`);
      const { info, replaced } = put;
      const path = info.path ?? info.name;
      const text = replaced
        ? `replaced ${path} (artifact ${info.id}); the earlier version is kept for your owner`
        : `wrote ${path} (artifact ${info.id}) in your files; your owner can open it in the app`;
      return {
        output: [{ type: "text" as const, text }],
        structuredOutput: { id: info.id, name: info.name, path, replaced },
        details: { id: info.id, name: info.name, mime: info.mime, bytes: info.bytes, path },
      };
    },
  });

/** An image artifact as a viewable image block, or a note when it exceeds the model budget. */
const imageRead = (dir: string, info: ArtifactInfo) => {
  const data = readArtifactBytes(dir, info.id);
  const base64 = data === undefined ? "" : data.data.toString("base64");
  if (data === undefined || base64.length > MAX_IMAGE_BASE64) {
    return {
      output: [
        {
          type: "text" as const,
          text: `# ${info.name}\n\n[image ${info.mime} not shown: over the size cap]`,
        },
      ],
    };
  }
  return {
    output: [
      { type: "text" as const, text: `# ${info.name}\n\n(image file, shown below)` },
      { type: "image" as const, data: base64, mimeType: info.mime },
    ],
  };
};

const artifactReadTool = (dirOf: (conversationId: string) => string): Tool =>
  defineTool({
    name: "artifact_read",
    description:
      "Read a workspace artifact by id: text files return their UTF-8 content (capped); " +
      "images attach to your context as viewable images.",
    parameters: obj({ id: str({ description: "The artifact id." }) }, { open: true }),
    execute: (args, api) => {
      const dir = dirOf(String(api.conversationId));
      const info = readArtifactInfo(dir, args.id);
      if (info === undefined) {
        return Promise.resolve({
          output: [{ type: "text" as const, text: `unknown artifact: ${args.id}` }],
          isError: true as const,
        });
      }
      if (VISION_MIMES.has(info.mime)) return Promise.resolve(imageRead(dir, info));
      const found = readArtifact(dir, args.id);
      if (found === undefined) {
        return Promise.resolve({
          output: [{ type: "text" as const, text: `unknown artifact: ${args.id}` }],
          isError: true as const,
        });
      }
      return Promise.resolve({
        output: [{ type: "text" as const, text: `# ${found.info.name}\n\n${found.text}` }],
      });
    },
  });

const ListParams = obj(
  {
    query: opt(str({ description: "Search artifact names and text content (case-insensitive)." })),
    scope: opt(
      oneOf(["session", "all"], {
        description:
          '"session" (default): only this conversation\'s artifacts. "all": search the whole ' +
          "workspace; use it when the file was not written in this conversation.",
      }),
    ),
  },
  { open: true },
);

const artifactListTool = (dirOf: (conversationId: string) => string): Tool =>
  defineTool({
    name: "artifact_list",
    description:
      "List or search your files as artifacts (id, path, type, size, recency). Defaults to " +
      'THIS conversation\'s artifacts; widen with scope "all" when needed, which searches this ' +
      "profile's whole workspace.",
    parameters: ListParams,
    structuredOutputSchema: arr(ArtifactInfoSchema),
    execute: (args, api) => {
      const scopeAll = args.scope === "all";
      const items = searchArtifacts(dirOf(String(api.conversationId)), {
        ...(scopeAll ? {} : { conversationId: String(api.conversationId) }),
        ...(args.query !== undefined ? { query: args.query } : {}),
      });
      const rows = items.map((item) => ({ ...item }));
      return Promise.resolve({
        output: [{ type: "text" as const, text: JSON.stringify(items) }],
        structuredOutput: rows,
      });
    },
  });

const artifactDeleteTool = (dirOf: (conversationId: string) => string): Tool =>
  defineTool({
    name: "artifact_delete",
    gated: true,
    description:
      "Delete one of your files by artifact id, from every path it sits at, with its earlier " +
      "versions. It can't be undone and your owner approves each call: first name the file " +
      "and say so.",
    parameters: obj({ id: str({ description: "The artifact id." }) }, { open: true }),
    execute: async (args, api) => {
      if (!(await removeFile(dirOf(String(api.conversationId)), args.id)))
        return fail(`unknown artifact: ${args.id}`);
      return {
        output: [{ type: "text" as const, text: `deleted ${args.id}` }],
        structuredOutput: { id: args.id, deleted: true },
      };
    },
  });

export type ArtifactWriteInput = Static<typeof WriteParams>;

/** The workspace plugin: always on; the store resolves per conversation when a holder is set. */
export const artifactsPlugin = (options: ArtifactsOptions = {}): Plugin => {
  const root = options.root ?? artifactsDir();
  const holder = options.holder;
  const dirOf = (conversationId: string): string =>
    holder === undefined ? root : scopeDir(holder, conversationId, root);
  return definePlugin({
    id: "ultiv.artifacts",
    version: "1.3.0",
    description:
      "The artifact workspace: open writes by path (a taken path is replaced, its earlier " +
      "version kept), gated deletes, reads, and session-scoped search, partitioned per " +
      "profile when a scope resolver is wired.",
    capabilities: [
      toolCapability(artifactWriteTool(dirOf, holder)),
      toolCapability(artifactReadTool(dirOf)),
      toolCapability(artifactListTool(dirOf)),
      toolCapability(artifactDeleteTool(dirOf)),
    ],
  });
};
