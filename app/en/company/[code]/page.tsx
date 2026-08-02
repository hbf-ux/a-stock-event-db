import EnglishIntelligenceDetail from "../../intelligence-detail-en";
export default async function EnglishCompanyPage({ params }: { params: Promise<{ code: string }> }) { const { code } = await params; return <EnglishIntelligenceDetail kind="company" entityKey={decodeURIComponent(code)} />; }
