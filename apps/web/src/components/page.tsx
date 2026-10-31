import { useEffect } from "react";
import { pageTitle } from "@/lib/brand";

/** Sets the tab's title ("Crew · Spreissen") while a screen is open. */
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
  children: React.ReactNode;
}) {
  useDocumentTitle(docTitle ?? (typeof title === "string" ? title : undefined));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-8">
        <header className="flex flex-col gap-1.5">
          {back}
          {hero ?? (
            <>
              <h1 className="font-heading text-title font-semibold tracking-tight">{title}</h1>
              {lead !== undefined && <p className="text-muted-foreground text-sm">{lead}</p>}
              <div className="border-t" />
            </>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
