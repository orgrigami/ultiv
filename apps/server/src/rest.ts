/**
 * The REST surface: session registry, model catalog, tasks, artifacts,
 * webhooks (also the `/hooks/:id` ingress), cron jobs, profiles, mailbox,
 * vault, connectors (MCP), approvals, memory and the audit tail. Plain REST on purpose — CRUD
 * over chord's replicated-object wire desyncs on attach (chord 1.4.0
 * ack-window bug). Owner scoping rides `x-ultiv-user`; routes live in ./rest.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MindService } from "@ultiv/mind";
import type { CronScheduler } from "./cron.ts";
import { ownerOf, principalFromRequest } from "./identity.ts";
import { errorOf, queryOr, type RouteArgs } from "./rest/types.ts";
import { approvalRoutes } from "./rest/approvals.ts";
import { secretRoutes } from "./rest/secrets.ts";
import { artifactRoutes } from "./rest/artifacts.ts";
import { cronRoutes } from "./rest/cron.ts";
import { mailboxRoutes } from "./rest/mailbox.ts";
import { memoryRoutes, profileRoutes } from "./rest/profiles.ts";
import { memoryV2Routes } from "./rest/memory-v2.ts";
import { skillRoutes } from "./rest/skills.ts";
import { roomRoutes } from "./rest/rooms.ts";
import { taskRoutes } from "./rest/tasks.ts";
import { bindingRoutes } from "./rest/bindings.ts";
import { vaultRoutes } from "./rest/vault.ts";
import { webhookRoutes } from "./rest/webhooks.ts";
import { sensorRoutes } from "./rest/sensors.ts";
import { pushRoutes } from "./rest/push.ts";
import { mcpRoutes } from "./rest/mcp.ts";
import type { PushService } from "./push/index.ts";

export interface RestDeps {
  readonly mind: MindService;
  readonly scheduler: CronScheduler;
  readonly push?: PushService;
}

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const readJson = async <T>(req: IncomingMessage): Promise<T> => {
  const raw = (await readBody(req)).toString("utf8");
  return (raw === "" ? {} : JSON.parse(raw)) as T;
};

export const createRestHandler = (deps: RestDeps) => {
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-ultiv-user",
  };
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const args: RouteArgs = {
      mind: deps.mind,
      scheduler: deps.scheduler,
      ...(deps.push !== undefined ? { push: deps.push } : {}),
      req,
      res,
      url,
      owner: ownerOf(principalFromRequest(req)),
      path: url.pathname,
      json,
      readJson,
      readBody,
    };
    void route(args).catch((error) => json(500, { error: String(error).slice(0, 300) }));
  };
};

async function route(args: RouteArgs): Promise<void> {
  const { req, path, mind, json } = args;
  const method = req.method ?? "GET";
  const segment = (after: string): string => decodeURIComponent(path.slice(after.length));

  if (path === "/api/sessions" && method === "GET") {
    const profile = queryOr(args, "profile");
    return json(200, await mind.profiles.listSessions(args.owner, profile));
  }
  if (path === "/api/sessions" && method === "POST") {
    const body = await args.readJson<{ title?: string | null; profileId?: string }>(req);
    try {
      // No profile given: fall back to the owner's main bot. A fresh
      // workspace has neither — refuse with the remedy, not a mystery.
      const profileId = body.profileId ?? (await mind.profiles.mainOf(args.owner));
      if (profileId === null) {
        return json(400, { error: "spawn a bot first — sessions attach to a bot" });
      }
      return json(
        200,
        await mind.profiles.createSession(args.owner, profileId, body.title ?? null),
      );
    } catch (cause) {
      return json(400, { error: errorOf(cause) });
    }
  }
  if (path.startsWith("/api/sessions/") && method === "DELETE") {
    return json(200, {
      ok: await mind.profiles.removeSession(args.owner, segment("/api/sessions/")),
    });
  }
  if (path === "/api/models") {
    return json(
      200,
      mind.models.list().map((spec) => ({
        id: spec.ref,
        label: spec.label,
        provider: spec.provider,
        providerName: spec.providerName,
        efforts: [...spec.efforts],
        defaultEffort: spec.defaultEffort,
        input: [...spec.input],
      })),
    );
  }
  if (path === "/api/models/catalog" && method === "GET") {
    return json(200, { ...mind.models.status(), default: mind.models.defaultRef() });
  }
  if (path === "/api/models/refresh" && method === "POST") {
    const status = await mind.models.refresh(true);
    return json(200, { ...status, default: mind.models.defaultRef() });
  }
  if (path === "/api/audit" && method === "GET") {
    const limit = Number(args.url.searchParams.get("limit") ?? "100");
    const capped = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1_000) : 100;
    const profile = queryOr(args, "profile");
    const conversation = queryOr(args, "conversation");
    const kind = queryOr(args, "kind");
    // Narrow filters read a wider window, then keep the newest `capped`.
    const narrow = conversation !== undefined || kind !== undefined;
    const events = mind.audit
      .tail(narrow ? 5_000 : capped)
      .filter((event) => profile === undefined || event.profile === profile)
      .filter((event) => conversation === undefined || event.conversationId === conversation)
      .filter((event) => kind === undefined || event.kind === kind)
      .slice(-capped);
    return json(200, events);
  }
  // Routine fire receipts — "did it actually fire?" is a lookup, not a guess.
  if (path === "/api/routines/events" && method === "GET") {
    const limit = Number(args.url.searchParams.get("limit") ?? "100");
    const routine = queryOr(args, "routine");
    const source = queryOr(args, "source");
    return json(
      200,
      await mind.receipts.list({
        ...(routine !== undefined ? { routineId: routine } : {}),
        ...(source !== undefined
          ? { source: source as "cron" | "webhook" | "sensor" | "test" }
          : {}),
        limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 400) : 100,
      }),
    );
  }
  // A bot's durable KV state: the owner can read (and curate) what its bots
  // wrote — the "what does it think it already did" store.
  if (path === "/api/state" && method === "GET") {
    const profile = queryOr(args, "profile");
    if (profile === undefined) return json(400, { error: "profile is required" });
    return json(200, await mind.state.list(profile));
  }
  if (path.startsWith("/api/state/") && method === "DELETE") {
    const rest = segment("/api/state/");
    const slash = rest.indexOf("/");
    if (slash <= 0) return json(400, { error: "path is /api/state/<profileId>/<key>" });
    const profile = rest.slice(0, slash);
    const key = decodeURIComponent(rest.slice(slash + 1));
    return json(200, { ok: await mind.state.delete(profile, key) });
  }
  if (await profileRoutes(args)) return;
  if (await memoryRoutes(args)) return;
  if (await memoryV2Routes(args)) return;
  if (await skillRoutes(args)) return;
  if (await mailboxRoutes(args)) return;
  if (await roomRoutes(args)) return;
  if (await taskRoutes(args, segment)) return;
  if (await artifactRoutes(args, segment)) return;
  if (await webhookRoutes(args, segment)) return;
  if (await cronRoutes(args, segment)) return;
  if (await sensorRoutes(args, segment)) return;
  if (await bindingRoutes(args, segment)) return;
  if (await vaultRoutes(args, segment)) return;
  if (await mcpRoutes(args)) return;
  if (await approvalRoutes(args)) return;
  if (await secretRoutes(args)) return;
  if (await pushRoutes(args)) return;
  if (path === "/" || path === "/api/health") return json(200, { app: "ultiv", ok: true });
  json(404, { error: `no route: ${method} ${path}` });
}
