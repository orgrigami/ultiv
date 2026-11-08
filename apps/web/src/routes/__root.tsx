import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { SideNav, TabBar } from "@/components/app-nav";
import { QuickSwitchProvider } from "@/components/quick-switcher";
import { RouteError, RouteNotFound } from "@/components/route-error";
import { WorkPane } from "@/components/work-pane";
import { AppProvider } from "@/lib/app-state";
import { SignInGate } from "@/components/sign-in-gate";
import { WorkPaneProvider } from "@/lib/work-pane";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: RouteNotFound,
});

/**
 * One layout for every screen: the sidebar (tablet and up) or tab bar
 * (phones) around the routed screen, and the work pane beside it on desktop
 * (a sheet below that). --chat-bottom tells the chat how much room the tab
 * bar takes, so its composer floats just above it. The quick switcher
 * (Cmd/Ctrl-K) and the N and ? shortcuts work on every screen.
 */
function RootLayout() {
  return (
    <div className="root bg-background text-foreground flex h-dvh w-full antialiased">
      <SignInGate>
        <AppProvider>
          <WorkPaneProvider>
            <QuickSwitchProvider>
              <SideNav />
              <div className="relative flex min-w-0 flex-1" data-work-surface>
                <main className="flex min-w-0 flex-1 flex-col [--chat-bottom:calc(var(--tabbar-h)+0.75rem+env(safe-area-inset-bottom))] sm:pt-4 sm:[--chat-bottom:max(1rem,env(safe-area-inset-bottom))]">
                  <Outlet />
                </main>
                <WorkPane />
              </div>
              <TabBar />
            </QuickSwitchProvider>
          </WorkPaneProvider>
        </AppProvider>
      </SignInGate>
      <Toaster position="top-center" theme="system" closeButton />
    </div>
  );
}
