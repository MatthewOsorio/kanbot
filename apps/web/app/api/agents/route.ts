import { route } from "@/lib/api";
import { roster } from "@/lib/agents";

export const dynamic = "force-dynamic"; // agent files are read per request

export const GET = route(async () => Response.json(await roster()));
