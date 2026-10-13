import { solidContent } from "../../lit/solid-content.tsx";
import { restoredInstantThreadPage } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionRoute } from "./new-session-page.tsx";

export const render = (data: NewSessionRouteData) =>
  restoredInstantThreadPage(data) ?? solidContent(NewSessionRoute, { data });
