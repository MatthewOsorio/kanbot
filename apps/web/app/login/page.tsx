import { loadGitHubApp } from "@kanbot/shared/server";
import { LogIn } from "lucide-react";
import { Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  state: "That sign-in link expired or came from somewhere else. Try again.",
  github: "GitHub didn't answer as expected. Try again.",
  not_owner: "Only the GitHub account that created Kanbot's GitHub App can sign in.",
  exists: "Kanbot is already connected to a GitHub App.",
  no_app: "Connect GitHub first.",
};

/** Sign in (§12), or, before Kanbot has a GitHub App, the first click of the two-click setup (§10). */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [app, { error }] = await Promise.all([loadGitHubApp(db), searchParams]);
  return (
    <div className="mx-auto max-w-md px-6 pb-16">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <ThemeToggle />
      </header>
      <main className="mt-16 space-y-6 rounded-xl border bg-card p-6 shadow-xs">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {app ? "Sign in" : "Connect GitHub"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {app
              ? `Sign in with the GitHub account that owns Kanbot (${app.ownerLogin}).`
              : "Kanbot works through its own GitHub App. On GitHub, click Create, then pick the repos Kanbot may work on and click Install. The account that creates it is the one that can sign in."}
          </p>
        </div>
        {error && ERRORS[error] && (
          <p role="alert" className="text-sm text-destructive">
            {ERRORS[error]}
          </p>
        )}
        {/* Plain links: both leave for github.com. */}
        <a
          href={app ? "/api/auth/login" : "/api/github/setup"}
          className={buttonVariants({ className: "w-full" })}
        >
          <LogIn aria-hidden />
          {app ? "Sign in with GitHub" : "Connect GitHub"}
        </a>
      </main>
    </div>
  );
}
