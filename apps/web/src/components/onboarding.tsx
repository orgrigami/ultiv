/**
 * First-run onboarding: pick a template and the bot exists with a sensible
 * identity, seeded to introduce itself in its own chat — which the home screen
 * opens straight into. Custom identity stays available below the templates.
 * Each template's promises follow the server check (lib/onboarding-templates.ts):
 * what isn't set up here says so, with the key that turns it on.
 */
import { CheckIcon, CircleDashedIcon, SproutIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelInfo } from "@spriessen/contracts";
import { catalogSummary } from "@/components/model-options";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  readinessOf,
  templatesFor,
  type Bullet,
  type Readiness,
  type Template,
} from "@/lib/onboarding-templates";

export function OnboardingHome({
  models,
  custom,
  onCreated,
}: {
  models: ModelInfo[];
  /** The custom path — rendered below the templates (the Bots panel). */
  custom: React.ReactNode;
  onCreated: (profileId: string) => Promise<void>;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  useEffect(() => {
    let live = true;
    api.serverCheck().then(
      (check) => live && setReadiness(readinessOf(check)),
      () => undefined, // Unknown readiness keeps the bullets neutral.
    );
    return () => {
      live = false;
    };
  }, []);

  const spawn = async (template: Template): Promise<void> => {
    setBusyKey(template.key);
    setError(null);
    try {
      const profile = await api.createProfile({
        name: template.name,
        description: template.description,
        persona: template.persona,
      });
      await onCreated(profile.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SproutIcon className="size-4" /> Meet your first bot
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          Pick a starting point. The bot introduces itself in its own chat, and you can change its
          name, personality or model any time.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {templatesFor(readiness).map((template) => (
            <div key={template.key} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold">{template.name}</p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyKey !== null}
                  onClick={() => void spawn(template)}
                >
                  {busyKey === template.key ? "Creating…" : "Create"}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{template.description}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {template.bullets.map((bullet) => (
                  <BulletLine key={bullet.text} bullet={bullet} />
                ))}
              </ul>
            </div>
          ))}
        </div>
        {error !== null && <p className="text-destructive text-sm">{error}</p>}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground shrink-0 text-xs ">or your own</span>
          <div className="min-w-0 flex-1">{custom}</div>
        </div>
        <p className="text-muted-foreground text-xs">
          {models.length > 0
            ? `Models available: ${catalogSummary(models)}.`
            : "Couldn't load the model list, so the default model is used."}
        </p>
      </CardContent>
    </Card>
  );
}

function BulletLine({ bullet }: { bullet: Bullet }) {
  const Icon = bullet.ready ? CheckIcon : CircleDashedIcon;
  return (
    <li
      className={`flex items-start gap-1.5 text-xs ${bullet.ready ? "" : "text-muted-foreground"}`}
    >
      <Icon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
      <span>
        {bullet.text}
        {bullet.need !== undefined && <span className="block">Turn on: {bullet.need}</span>}
      </span>
    </li>
  );
}
