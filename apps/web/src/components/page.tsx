import { useEffect } from "react";
import { pageTitle } from "@/lib/brand";
import { Heading } from "@/components/ui/heading";

/** Sets the tab's title ("Crew · Spriessen") while a screen is open. */
export function useDocumentTitle(screen: string | undefined): void {
  useEffect(() => {
    document.title = pageTitle(screen);
  }, [screen]);
}

/** A non-chat screen: a title, an optional lead line, and its own scroll. */
export function Page({
  title,
  docTitle,
  lead,
  back,
  hero,
  actions,
  children,
}: {
  title: React.ReactNode;
  /** The tab title when `title` isn't plain text. */
  docTitle?: string | undefined;
  lead?: string | undefined;
  /** A link above the title back to the parent screen. */
  back?: React.ReactNode;
  /** Replaces the title block (it must carry its own h1): the bot profile. */
  hero?: React.ReactNode;
  /** The screen's actions, top right beside the title; they wrap under it on phones. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  useDocumentTitle(docTitle ?? (typeof title === "string" ? title : undefined));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-8">
        <header className="flex flex-col gap-1.5">
          {back}
          {hero ?? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <Heading level={1} size="title" className="min-w-0">
                  {title}
                </Heading>
                {actions !== undefined && (
                  <div className="flex shrink-0 items-center gap-2">{actions}</div>
                )}
              </div>
              {lead !== undefined && <p className="text-muted-foreground text-sm">{lead}</p>}
              {lead !== undefined && <div className="border-t" />}
            </>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
