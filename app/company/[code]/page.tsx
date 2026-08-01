import IntelligenceDetail from "../../intelligence-detail";

export default async function CompanyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <IntelligenceDetail kind="company" entityKey={decodeURIComponent(code)} />;
}
