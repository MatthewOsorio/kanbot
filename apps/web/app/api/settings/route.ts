import { patchSettingsBody } from "@kanbot/shared";
import { parseBody, route } from "@/lib/api";
import { patchSettings, settingsView } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => Response.json(await settingsView()));

/** Pause all (FR-63) and the daily cap (§14). */
export const PATCH = route(async (req) =>
  Response.json(await patchSettings(await parseBody(req, patchSettingsBody))),
);
