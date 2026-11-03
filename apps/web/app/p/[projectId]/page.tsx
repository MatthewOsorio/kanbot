import { Board } from "@/components/board";

export default async function BoardPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <Board projectId={projectId} />;
}
