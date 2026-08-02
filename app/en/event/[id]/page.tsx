import EnglishIntelligenceDetail from "../../intelligence-detail-en";
export default async function EnglishEventPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <EnglishIntelligenceDetail kind="event" entityKey={decodeURIComponent(id)} />; }
