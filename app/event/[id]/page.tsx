import IntelligenceDetail from "../../intelligence-detail";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IntelligenceDetail kind="event" entityKey={decodeURIComponent(id)} />;
}
