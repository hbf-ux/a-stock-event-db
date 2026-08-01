import IntelligenceDetail from "../../intelligence-detail";

export default async function ShareholderPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <IntelligenceDetail kind="shareholder" entityKey={decodeURIComponent(name)} />;
}
