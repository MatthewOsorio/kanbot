import { costsQuery } from "@kanbot/shared";
import { route } from "@/lib/api";
import { costs } from "@/lib/costs";

export const dynamic = "force-dynamic";

export const GET = route(async (req) =>
  Response.json(await costs(costsQuery.parse(Object.fromEntries(new URL(req.url).searchParams)))),
);
