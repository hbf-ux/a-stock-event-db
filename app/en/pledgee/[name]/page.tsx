import EnglishIntelligenceDetail from "../../intelligence-detail-en";
export default async function EnglishPledgeePage({ params }: { params: Promise<{ name: string }> }) { const { name } = await params; return <EnglishIntelligenceDetail kind="pledgee" entityKey={decodeURIComponent(name)} />; }
