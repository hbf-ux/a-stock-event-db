import IntelligenceDetail from "../../intelligence-detail";

export default async function PledgeePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <IntelligenceDetail kind="pledgee" entityKey={decodeURIComponent(name)} />;
}
