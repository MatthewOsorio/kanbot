/**
 * Secrets never reach stored run events or recorded scripts (requirements §14): the API key and the
 * project's env vars (`more`), as written and as escaped inside JSON. Values under 8 characters are kept
 * (redacting "1" would mangle everything).
 */
export const redactText = (s: string, more: string[] = []) =>
  // Read on each call: main.ts loads .env after this module is imported.
  [process.env.ANTHROPIC_API_KEY, ...more]
    .filter((v): v is string => !!v && v.length >= 8)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
    .reduce((t, v) => t.replaceAll(v, "[redacted]"), s);

/**
 * Secrets never reach stored run events (requirements §14). NUL characters are dropped too: Postgres
 * jsonb rejects `\u0000`, so one in a tool's output would fail the run mid-way.
 */
export const redact = (payload: Record<string, unknown>, secrets: string[]) =>
  JSON.parse(
    redactText(
      JSON.stringify(payload, (_, v: unknown) =>
        typeof v === "string" ? v.replaceAll("\0", "") : v,
      ),
      secrets,
    ),
  ) as Record<string, unknown>;
