import EnglishIntelligenceDetail from "../../intelligence-detail-en";
export default async function EnglishShareholderPage({ params }: { params: Promise<{ name: string }> }) { const { name } = await params; return <EnglishIntelligenceDetail kind="shareholder" entityKey={decodeURIComponent(name)} />; }
