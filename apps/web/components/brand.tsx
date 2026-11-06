import { Bot } from "lucide-react";
import Link from "next/link";

/** The app mark: a little bot on the accent color. Also used on Home and Settings. */
export function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Bot aria-hidden className="size-4" />
      </span>
      Kanbot
    </Link>
  );
}

/** Native select styled like the shadcn Input (no Select component generated yet). */
export const SELECT =
  "h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
