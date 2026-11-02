/**
 * The main bot's admin tools in one list (bot_create, the bot tools and the
 * department tools), and the host app's authorization seam they share with
 * the host-access decision.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { botCreateTools } from "../profiles/bot-create.ts";
import { botAdminTools } from "./bot-tools.ts";
import type { AdminDeps, MindAdmin } from "./common.ts";
import { departmentTools } from "./department-tools.ts";

export * from "./common.ts";
export * from "./bot-tools.ts";
export * from "./department-tools.ts";

/**
 * Authorization from the host app. `hostAccess` decides the beyond-VM
 * capability (bash's `host` and `node` targets, and other tools that run on
 * the server's own machine) per
 * conversation scope; absent, the owner's bots keep today's behaviour
 * (always allowed). `mayAdminister` and `purgeBot` serve the admin tools.
 */
export interface MindAuthz extends MindAdmin {
  readonly hostAccess?: (scope: {
    readonly owner: string;
    readonly profileId: string | null;
  }) => boolean | Promise<boolean>;
}

export const adminTools = (deps: AdminDeps): readonly ToolRegistration[] => [
  ...botCreateTools(deps),
  ...botAdminTools(deps),
  ...departmentTools(deps),
];
