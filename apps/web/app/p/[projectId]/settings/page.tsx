import { SettingsForm } from "@/components/settings-form";

export default async function SettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SettingsForm projectId={projectId} />;
}
