import { idParam, route } from "@/lib/api";
import { getScreenshot } from "@/lib/tickets";

/** A QA browser screenshot (§4), shown in the drawer with its test report. */
export const GET = route(
  async (_req, ctx) =>
    new Response(new Uint8Array(await getScreenshot(await idParam(ctx))), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    }),
);
