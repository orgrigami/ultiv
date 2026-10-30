/**
 * Owner input with attachments: build what the mind admits — the prompt
 * content (text plus, on vision models, the images themselves as blocks)
 * and the entry metadata the transcript projection renders chips from.
 * Images ride inline only when the session's model accepts image input;
 * everything else keeps the reference-line block the bot opens itself
 * with artifact_read. One strip-point (`ATTACHMENTS_MARK`) keeps display
 * surfaces from showing the machinery.
 */
import { join } from "node:path";
import type { Conversation, InputEntry, UserInput } from "@earendil-works/pi-durable";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ArtifactInfo, AttachmentRef } from "@ultiv/contracts";
import {
  artifactsDir,
  MAX_IMAGE_BASE64,
  readArtifactBytes,
  readArtifactInfo,
  VISION_MIMES,
} from "@ultiv/ext";
import { ATTACHMENTS_MARK, INPUT_ENTRY_KIND, type MindService } from "@ultiv/mind";
import { Effect } from "effect";

export interface BuiltInput {
  readonly content: UserInput;
  readonly entry: InputEntry;
}

export interface BuildInputArgs {
  readonly text: string;
  readonly attachments: readonly string[];
  readonly owner: string;
  readonly mind: MindService;
  readonly chat: Conversation;
}

/** Every directory this owner's artifacts may live in: profile dirs + the legacy root. */
const dirsOf = async (mind: MindService, owner: string): Promise<string[]> => {
  const root = artifactsDir();
  const profiles = await mind.profiles.list(owner);
  return [root, ...profiles.map((p) => join(root, owner, p.id))];
};

/** Find an artifact across the owner's dirs; undefined when absent everywhere. */
const resolveArtifact = async (
  mind: MindService,
  owner: string,
  id: string,
): Promise<{ dir: string; info: ArtifactInfo } | undefined> => {
  for (const dir of await dirsOf(mind, owner)) {
    const info = readArtifactInfo(dir, id);
    if (info !== undefined) return { dir, info };
  }
  return undefined;
};

/** Whether the conversation's current model (or the mind's default) accepts image input. */
const visionOf = async (mind: MindService, chat: Conversation): Promise<boolean> => {
  try {
    const selection = await Effect.runPromise(mind.converse.agentOf(chat));
    const ref = selection.model ?? mind.models.defaultRef();
    return mind.models.find(ref)?.input.includes("image") === true;
  } catch {
    return false;
  }
};

/** Base64 of an artifact's bytes, when it fits the per-image model budget. */
const imageDataOf = (dir: string, id: string): string | undefined => {
  const bytes = readArtifactBytes(dir, id);
  if (bytes === undefined) return undefined;
  const base64 = bytes.data.toString("base64");
  return base64.length <= MAX_IMAGE_BASE64 ? base64 : undefined;
};

const refOf = (info: ArtifactInfo): AttachmentRef => ({
  id: info.id,
  name: info.name,
  mime: info.mime,
  bytes: info.bytes,
});

/** One bullet per attachment; inline images say so instead of pointing at artifact_read. */
const lineOf = (info: ArtifactInfo, inline: boolean): string =>
  inline
    ? `- "${info.name}" (${info.mime}): included as an image in this message`
    : `- artifact ${info.id} "${info.name}" (${info.mime}): use artifact_read to open it`;

/** Build the admitted input: content blocks (text + inline images) plus the chip-carrying entry. */
export const buildInputContent = async (args: BuildInputArgs): Promise<BuiltInput> => {
  const vision = await visionOf(args.mind, args.chat);
  const images: ImageContent[] = [];
  const refs: AttachmentRef[] = [];
  const lines: string[] = [];
  for (const id of args.attachments) {
    const found = await resolveArtifact(args.mind, args.owner, id);
    if (found === undefined) {
      lines.push(`- artifact ${id}: (unknown)`);
      continue;
    }
    const { dir, info } = found;
    const data = vision && VISION_MIMES.has(info.mime) ? imageDataOf(dir, info.id) : undefined;
    refs.push(refOf(info));
    lines.push(lineOf(info, data !== undefined));
    if (data !== undefined) images.push({ type: "image", data, mimeType: info.mime });
  }
  const text: TextContent = {
    type: "text",
    text: `${args.text}${ATTACHMENTS_MARK}\n${lines.join("\n")}`,
  };
  return {
    content: [text, ...images],
    entry: { kind: INPUT_ENTRY_KIND, data: { attachments: refs } },
  };
};
