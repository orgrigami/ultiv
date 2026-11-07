/**
 * The Now page's goals in motion: every bot's active and paused projects, a
 * line each with its progress; a tap opens the bot's Projects tab, where the
 * owner steers them. Loads on the page, follows the `projects` signal.
 */
import { useNavigate } from "@tanstack/react-router";
import { BotAvatar } from "@/components/bot-avatar";
import { ListCard } from "@/components/ui/list-card";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { goalsInMotion, milestoneText } from "@/lib/now";
import { useLiveLoad } from "@/lib/use-live-load";

export function GoalsSection() {
  const { sessions } = useApp();
  const navigate = useNavigate();
  const projects = useLiveLoad(
    "now-goals",
    () => api.projects(),
    ["projects"],
    "Goals may be out of date",
  );
  const goals = goalsInMotion(projects.value ?? []);
  // Goals are optional: no section until a bot has one (or while loading).
  if (goals.length === 0) return null;
  const botOf = (id: string) => sessions.profiles.find((row) => row.id === id);
  return (
    <section aria-label="Goals" className="flex flex-col gap-2">
      <SectionHeader title="Goals in motion" />
      <ListCard className="p-1">
        {goals.map((project) => {
          const bot = botOf(project.profileId);
          return (
            <ListRow
              key={project.id}
              leading={<BotAvatar id={project.profileId} name={bot?.name ?? ""} size="sm" />}
              title={project.title}
              subtitle={[
                bot?.name,
                milestoneText(project),
                project.status === "paused" ? "paused" : "",
              ]
                .filter((part) => part !== undefined && part !== "")
                .join(" · ")}
              onClick={() =>
                void navigate({
                  to: "/crew/$botId",
                  params: { botId: project.profileId },
                  search: { tab: "projects" },
                })
              }
            />
          );
        })}
      </ListCard>
    </section>
  );
}
