import { AgentsPage } from "@/components/agents-page";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string; v?: string }>;
}) {
  const { slug, v } = await searchParams;
  return <AgentsPage initialSlug={slug} version={v} />;
}
