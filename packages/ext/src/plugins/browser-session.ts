/**
 * Interactive browser sessions in the home VM — the facility behind
 * `browser_session` (browser-session-tool.ts). ONE chromium per home VM,
 * run by the VM's browser broker (browser/vm) as its own system user,
 * reached only through the VM's root exec: a bot's `bash` can reach neither
 * the broker nor the browser. Each bot gets one session — a private
 * context (its own cookies) and one main tab with its popups — held by one
 * conversation at a time, ended by close, by its task ending, by 10 idle
 * minutes, or by the owner (browser/session-life.ts). Sign-ins the bot made
 * are saved sealed and restored next time (browser/signins.ts). A takeover
 * ask BLOCKS while the owner drives the LIVE CAST (browser/cast.ts) and
 * returns the page when they Finish; while it is open the session never
 * idles out and the bot's own acts are refused.
 */
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { type ScopeHolder } from "./vault.ts";
import { pathForName, putFile } from "../fs/tree.ts";
import type { ShellBackend } from "../shell/backend.ts";
import { browserBackends } from "../browser/backends.ts";
import { brokerClient, type BrokerClient } from "../browser/broker-client.ts";
import type { BrokerPaths } from "../browser/broker-install.ts";
import { castSessions, type CastSessions } from "../browser/cast.ts";
import { activeBrowsers, type ActiveBrowsers } from "../browser/active.ts";
import { takeoverRegistry, type TakeoverRegistry } from "../browser/takeover.ts";
import { browserLife, type BrowserLife } from "../browser/session-life.ts";
import { signinStore, type SigninStore } from "../browser/signins.ts";
import { readArtifactBytes, searchArtifacts } from "./artifacts.ts";
import { browserSessionTool } from "./browser-session-tool.ts";

export { browserActText, isActOp } from "./browser-session-tool.ts";

export interface BrowserSessionOptions {
  /** Artifact root; default ARTIFACTS_DIR (screenshots and downloads are stored there). */
  readonly root?: string;
  /** Profile-scope resolver; when set, the run uses the conversation's home VM. */
  readonly holder?: ScopeHolder | undefined;
  /** Backend factory override for tests (a fake exec answering broker JSON). */
  readonly backend?:
    | ((dir: string, homeDir: string, guestRoot: string) => ShellBackend)
    | undefined;
  /** Where the broker lives in the VM (tests run it locally). */
  readonly paths?: BrokerPaths;
  /** A takeover's life span (tests shrink it); default TAKEOVER_MAX_MS. */
  readonly takeoverMaxMs?: number;
  /** The idle window (tests shrink it); default 10 minutes. */
  readonly idleMs?: number;
  /** Saved sign-ins; default the vault-sealed store (none without a vault key). */
  readonly signins?: SigninStore | null;
}

/** The plugin plus everything the owner's side drives. */
export interface BrowserSessionFacility {
  readonly plugin: Plugin;
  readonly takeovers: TakeoverRegistry;
  /** The owner's live casts (the takeover's driving seat, and the watch view). */
  readonly casts: CastSessions;
  /** Which bots have a browser going, which conversation holds it, where it stands. */
  readonly browsers: ActiveBrowsers;
  /** Close, release, forget, history. */
  readonly life: BrowserLife;
  readonly signins: SigninStore | undefined;
}

const UPLOAD_CAP = 25 * 1024 * 1024;

const mimeOfName = (name: string): string | undefined => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    zip: "application/zip",
  };
  return known[ext];
};

export const browserSessionFacility = (
  options: BrowserSessionOptions = {},
): BrowserSessionFacility => {
  const holder = options.holder;
  const { dirOf, resolveOf } = browserBackends(options);
  const client: BrokerClient = brokerClient(options.paths);
  const signins = options.signins === null ? undefined : (options.signins ?? signinStore());
  const scopeOf = (conversationId: string) => {
    const scope = holder?.get()?.scopeOf(conversationId);
    return scope?.profile === null || scope === undefined
      ? undefined
      : { owner: scope.owner, profile: scope.profile };
  };

  const save = async (
    conversationId: string,
    folder: string,
    name: string,
    bytes: Uint8Array,
    mime?: string,
  ) => {
    const scope = holder?.get()?.scopeOf(conversationId);
    const put = await putFile(dirOf(conversationId), pathForName(folder, name, "file"), bytes, {
      unique: true,
      ...(mime !== undefined ? { mime } : {}),
      conversationId,
      owner: scope?.owner ?? null,
      profile: scope?.profile ?? null,
    });
    return "info" in put ? { id: put.info.id, name: put.info.name } : undefined;
  };

  const saveDownload = (conversationId: string, name: string, bytes: Uint8Array) =>
    save(conversationId, "downloads", name, bytes, mimeOfName(name));

  // The cast dies with its ask, and the session wakes from its hold: any
  // close (finish, step-away, the cap, a newer ask) lifts both.
  const takeovers = takeoverRegistry({
    ...(options.takeoverMaxMs !== undefined ? { maxMs: options.takeoverMaxMs } : {}),
    onOpened: (conversationId) => void life.hold(conversationId, true).catch(() => undefined),
    onClosed: (conversationId) => {
      void casts.stop(conversationId).catch(() => undefined);
      void life.hold(conversationId, false).catch(() => undefined);
    },
  });
  const casts = castSessions({ resolveOf, client, saveDownload });
  const browsers = activeBrowsers();
  const life = browserLife({
    resolveOf,
    client,
    browsers,
    held: (conversationId) => takeovers.holds(conversationId),
    onEnded: (conversationId) =>
      void casts.stop(conversationId, "the browser session closed").catch(() => undefined),
    scopeOf,
    signins,
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
  });

  const fileOf = (
    conversationId: string,
    ref: string,
  ): { name: string; bytes: Uint8Array } | string => {
    const dir = dirOf(conversationId);
    const wanted = ref.trim();
    if (wanted === "") return "name the file to upload (its id or name)";
    const byId = readArtifactBytes(dir, wanted);
    const info =
      byId?.info ??
      searchArtifacts(dir, {}).find(
        (row) => row.name === wanted || row.name.toLowerCase() === wanted.toLowerCase(),
      );
    const got = byId ?? (info === undefined ? undefined : readArtifactBytes(dir, info.id));
    if (got === undefined)
      return `no file of yours is called "${wanted}" (use its id from your files)`;
    if (got.data.length > UPLOAD_CAP) return `"${got.info.name}" is larger than 25 MB`;
    return { name: got.info.name, bytes: new Uint8Array(got.data) };
  };

  const tool = browserSessionTool({
    life,
    takeovers,
    saveDownload,
    fileOf,
    saveShot: async (conversationId, png, url) => {
      if (png === "") return undefined;
      let host = "page";
      try {
        host = new URL(url ?? "").host.replace(/[^A-Za-z0-9._-]/g, "") || "page";
      } catch {
        // Not a url: the default name.
      }
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return save(
        conversationId,
        "screenshots",
        `browser-${host}-${stamp}.png`,
        new Uint8Array(Buffer.from(png, "base64")),
        "image/png",
      );
    },
  });

  const plugin = definePlugin({
    id: "ultiv.browser-session",
    version: "2.0.0",
    description:
      "Interactive browser sessions in the home VM: one broker-run chromium per VM, one private session per bot, reads ungated, acts approved (per-site rules allowed), password fields refused, downloads and uploads through the bot's files, sign-ins kept sealed; the owner's live cast drives the page during a takeover.",
    capabilities: [toolCapability(tool)],
  });
  return { plugin, takeovers, casts, browsers, life, signins };
};

/** The plugin alone, for embedders that do not surface takeovers. */
export const browserSessionPlugin = (options: BrowserSessionOptions = {}): Plugin =>
  browserSessionFacility(options).plugin;
