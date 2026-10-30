import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { SideNav, TabBar } from "@/components/app-nav";
import { AppProvider } from "@/lib/app-state";

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * One layout for every screen: the side rail (desktop) or tab bar (phones)
 * around the routed screen. --chat-bottom tells the chat how much room the
 * tab bar takes, so its composer floats just above it.
 */
function RootLayout() {
  return (
    <div className="root bg-background text-foreground flex h-dvh w-full antialiased">
      <AppProvider>
        <SideNav />
        <main className="flex min-w-0 flex-1 flex-col [--chat-bottom:calc(4.75rem+env(safe-area-inset-bottom))] sm:pt-4 sm:[--chat-bottom:max(1rem,env(safe-area-inset-bottom))]">
          <Outlet />
        </main>
        <TabBar />
      </AppProvider>
      <Toaster position="top-center" theme="system" richColors closeButton />
    </div>
  );
}
