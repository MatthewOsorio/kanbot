import { SetupWizard } from "@/components/setup-wizard";

export default async function SetupPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SetupWizard projectId={projectId} />;
}
