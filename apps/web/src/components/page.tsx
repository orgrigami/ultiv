/** A non-chat screen: a title, an optional lead line, and its own scroll. */
export function Page({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-8">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-heading text-[1.375rem] font-semibold tracking-tight">{title}</h1>
          {lead !== undefined && <p className="text-muted-foreground text-sm">{lead}</p>}
          <div className="plate-rule" />
        </header>
        {children}
      </div>
    </div>
  );
}
