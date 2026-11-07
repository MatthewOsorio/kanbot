import { onboardingActionBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { getOnboarding, onboardingAction } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, ctx) =>
  Response.json(await getOnboarding(await idParam(ctx))),
);

/** The owner's onboarding steps (§10): confirm commands, accept the baseline, CI PR, branch protection. */
export const POST = route(async (req, ctx) =>
  Response.json(
    await onboardingAction(await idParam(ctx), await parseBody(req, onboardingActionBody)),
  ),
);
