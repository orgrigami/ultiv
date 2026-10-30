import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { router } from "./router.ts";
import { followColorScheme } from "./lib/theme.ts";
import { registerServiceWorker, startPresence } from "./lib/push.ts";

followColorScheme();
registerServiceWorker();
startPresence();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
