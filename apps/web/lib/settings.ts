import type { patchSettingsBody } from "@kanbot/shared";
import { getSettings, spendToday, updateSettings } from "@kanbot/shared/server";
import type { z } from "zod";
import { db } from "./db";

/** What the top bar shows (§13): Pause all, why agents are paused, and today's spend vs the cap. */
export async function settingsView() {
  const [s, { spent }] = await Promise.all([getSettings(db), spendToday(db)]);
  return {
    paused: s.paused,
    pausedReason: s.pausedReason,
    dailyBudgetUsd: s.dailyBudgetUsd,
    spentTodayUsd: spent,
  };
}

export async function patchSettings(patch: z.infer<typeof patchSettingsBody>) {
  await db.transaction((tx) =>
    // Resuming clears a reason Kanbot set itself: the owner has dealt with it.
    updateSettings(tx, patch.paused === false ? { ...patch, pausedReason: null } : patch),
  );
  return settingsView();
}
