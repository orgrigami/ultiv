/**
 * Removing a team warns first and offers an export: the team
 * (name, Instructions, VM size) and each of its bots' export bundles in one
 * JSON file. While bots remain it can't go; one tap moves them all to the
 * org. Removal then needs the team's name typed.
 */
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { TeamInfo } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { orgApi } from "@/lib/org-api";
import { loadOrg } from "@/lib/use-org";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Downloads the team and its bots as one JSON file. */
export const exportTeam = async (team: TeamInfo, botIds: readonly string[]): Promise<void> => {
  const bots = await Promise.all(botIds.map((id) => orgApi.exportBot(id)));
  const file = {
    kind: "spriessen-team",
    version: 1,
    exportedAt: Date.now(),
    team,
    bots,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${team.name.replace(/[^\w-]+/g, "-").toLocaleLowerCase("en") || "team"}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

export function TeamRemove({ team }: { team: TeamInfo }) {
  const { sessions, refreshAll } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bots = sessions.profiles.filter((bot) => bot.teamId === team.id);
  const step = async (label: string, run: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const moveAll = () =>
    step("move", async () => {
      for (const bot of bots) await api.updateProfile(bot.id, { teamId: null });
      await refreshAll();
      void loadOrg();
    });
  const remove = () =>
    step("remove", async () => {
      await orgApi.removeTeam(team.id);
      setOpen(false);
      void navigate({ to: "/crew", replace: true });
    });
  return (
    <>
      <RowButton
        onClick={() => setOpen(true)}
        className="bg-card hover:bg-muted text-destructive flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-sm"
      >
        <Trash2Icon className="size-4 shrink-0" />
        <span className="flex-1">
          Remove team…
          <span className="text-meta text-muted-foreground block">
            Warns first and offers an export. Its bots move to the org before it goes.
          </span>
        </span>
      </RowButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setTyped("");
          setError(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Remove {team.name}?</DialogTitle>
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <p>
              Its Instructions, VM size, shared memory and templates go for good. Bots are never
              deleted with it.
            </p>
            <Button
              variant="outline"
              className="self-start"
              disabled={busy !== null}
              onClick={() =>
                void step("export", () =>
                  exportTeam(
                    team,
                    bots.map((bot) => bot.id),
                  ),
                )
              }
            >
              <DownloadIcon /> {busy === "export" ? "Exporting…" : "Export first"}
            </Button>
            {bots.length > 0 ? (
              <div className="bg-muted/50 flex flex-col gap-2 rounded-lg p-3">
                <p>
                  {bots.length === 1
                    ? "1 bot still lives here"
                    : `${bots.length} bots still live here`}
                  : {bots.map((bot) => bot.name).join(", ")}.
                </p>
                <Button
                  size="sm"
                  className="self-start"
                  disabled={busy !== null}
                  onClick={() => void moveAll()}
                >
                  {busy === "move" ? "Moving…" : "Move them all to the org"}
                </Button>
              </div>
            ) : (
              <label className="flex flex-col gap-1">
                Type {team.name} to remove it
                <Input value={typed} onChange={(event) => setTyped(event.target.value)} />
              </label>
            )}
            {error !== null && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                variant="destructive"
                disabled={busy !== null || bots.length > 0 || typed !== team.name}
                onClick={() => void remove()}
              >
                {busy === "remove" ? "Removing…" : "Remove team"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
