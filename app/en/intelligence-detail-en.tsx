"use client";

import { useEffect, useMemo, useState } from "react";

type Kind = "company" | "shareholder" | "pledgee" | "event";
type EventRow = { id?: string | number; announcementId?: string; date: string; code: string; name: string; shareholder: string; pledgee: string; amount: string; ratio?: string; total?: string; type: string; source: string; pdfUrl?: string; confidence?: number; parserVersion?: string; sha256?: string; verificationStatus?: "rules_validated" | "ai_reviewed" | "human_verified"; evidenceJson?: string };
type EventEvidence = { pageNumber?: number | null; matchedFields?: string[] };

const kindName: Record<Kind, string> = { company: "Listed company", shareholder: "Financing shareholder", pledgee: "Pledgee", event: "Pledge event" };
const verificationName: Record<string, string> = { rules_validated: "Rule validated", ai_reviewed: "OpenAI reviewed", human_verified: "Human verified" };
const eventType = (value: string) => value.includes("解除") ? "Pledge released" : value.includes("补充") ? "Supplemental pledge" : value.includes("新增") ? "New pledge" : value;
const route = (kind: Kind, key: string | number) => `/en/${kind}/${encodeURIComponent(String(key))}`;
const numberFrom = (value?: string) => Number((value || "").replace(/[^0-9.]/g, "")) || 0;

export default function EnglishIntelligenceDetail({ kind, entityKey }: { kind: Kind; entityKey: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const parameter = kind === "company" ? "stock" : kind === "event" ? "id" : kind;
    void fetch(`/api/events?${parameter}=${encodeURIComponent(entityKey)}&limit=500`, { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("The intelligence service is temporarily unavailable."); return response.json() as Promise<{ data: EventRow[] }>; })
      .then(payload => setEvents(payload.data || []))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [entityKey, kind]);

  const sorted = useMemo(() => [...events].sort((a, b) => b.date.localeCompare(a.date) || Number(b.id || 0) - Number(a.id || 0)), [events]);
  const title = kind === "company" ? (events[0]?.name || entityKey) : kind === "event" && events[0] ? `${events[0].name} · ${eventType(events[0].type)}` : entityKey;
  const supplemental = events.filter(row => row.type.includes("补充")).length;
  const releases = events.filter(row => row.type.includes("解除")).length;
  const high = events.filter(row => Math.max(numberFrom(row.ratio), numberFrom(row.total)) >= 50).length;
  const counterparties = new Set(events.map(row => kind === "pledgee" ? row.code : kind === "shareholder" ? row.pledgee : row.shareholder).filter(Boolean)).size;
  const riskScore = Math.min(100, supplemental * 18 + high * 12 + Math.max(0, events.length - releases) * 2);
  const riskLabel = riskScore >= 65 ? "Priority review" : riskScore >= 35 ? "Monitor" : "Routine review";
  const latest = sorted[0]?.date || "—";
  const first = sorted[sorted.length - 1]?.date || "—";
  useEffect(() => { document.title = `${title} | Pledge Radar`; }, [title]);

  const evidence: EventEvidence = (() => { try { return sorted[0]?.evidenceJson ? JSON.parse(sorted[0].evidenceJson) as EventEvidence : {}; } catch { return {}; } })();
  const evidenceEvent = kind === "event" ? sorted[0] : undefined;

  return <main className="publicIntelPage internationalDetailPage">
    <header className="publicHeader"><a className="publicBrand" href="/en"><span>P</span><b>Pledge Radar<small>A-SHARE FINANCE RISK INTELLIGENCE</small></b></a><nav><a href="/en">Live feed</a><a href="/en/pricing">Plans</a><a href="/">中文</a><a className="headerReportLink" href="/en/pricing">Research access</a></nav></header>
    <div className="publicWrap">
      <div className="publicBreadcrumb"><a href="/en">Home</a><span>/</span><span>{kindName[kind]}</span><span>/</span><b>{title}</b></div>
      <section className="entityHero"><div><p className="eyebrow">TRACEABLE A-SHARE PLEDGE INTELLIGENCE</p><div className="entityTitle"><h1>{title}</h1><span>{kindName[kind]}</span></div><p>Structured from official public disclosures. Every event retains its source filing, verification level and parsing audit trail.</p><div className="entityMeta"><span><i></i>Explicit verification status</span><span>Latest disclosure {latest}</span><span>History covered {first} to {latest}</span></div></div><div className={`publicScore ${riskScore >= 65 ? "high" : riskScore >= 35 ? "watch" : "normal"}`}><small>SCREENING SCORE</small><strong>{riskScore}</strong><b>{riskLabel}</b><em>For diligence prioritisation, not a credit conclusion</em></div></section>
      {loading ? <section className="publicState">Loading validated disclosure data…</section> : error && !events.length ? <section className="publicState error">{error}</section> : !events.length ? <section className="publicState">No field-validated pledge events were found for this entity.</section> : <>
        {evidenceEvent && <section className="publicPanel eventEvidencePanel"><div className="publicPanelHead"><div><p className="eyebrow">FIELD-LEVEL EVIDENCE</p><h2>Verification and source evidence</h2><p>Machine rules, OpenAI review and human verification remain separately labelled.</p></div><span className={`verification ${evidenceEvent.verificationStatus || "rules_validated"}`}>{verificationName[evidenceEvent.verificationStatus || "rules_validated"]}</span></div><div className="eventEvidenceGrid"><div><span>Verification level</span><b>{verificationName[evidenceEvent.verificationStatus || "rules_validated"]}</b><small>Validated fields are not presented as a credit conclusion.</small></div><div><span>Parser version</span><b>{evidenceEvent.parserVersion || "Not recorded"}</b><small>Confidence {evidenceEvent.confidence == null ? "—" : `${Math.round(evidenceEvent.confidence * 100)}%`}</small></div><div><span>Evidence location</span><b>{evidence.pageNumber ? `PDF page ${evidence.pageNumber}` : "Original filing retained"}</b><small>{evidence.matchedFields?.length ? `Matched: ${evidence.matchedFields.join(", ")}` : "Field locations will be enriched on reprocessing."}</small></div><div><span>Announcement ID</span><b>{evidenceEvent.announcementId || "—"}</b><small>SHA-256 {evidenceEvent.sha256 ? `${evidenceEvent.sha256.slice(0, 18)}…` : "generated after archiving"}</small></div></div><div className="eventEvidenceActions">{evidenceEvent.pdfUrl && <a href={`${evidenceEvent.pdfUrl}${evidence.pageNumber ? `#page=${evidence.pageNumber}` : ""}`} target="_blank" rel="noreferrer">Open official filing ↗</a>}<span>Source: {evidenceEvent.source}</span></div></section>}
        <section className="publicMetrics"><div><span>Historical events</span><strong>{events.length}</strong><small>Structured records</small></div><div><span>Supplemental pledges</span><strong className={supplemental ? "riskValue" : ""}>{supplemental}</strong><small>Potential financing-pressure signal</small></div><div><span>High-ratio events</span><strong className={high ? "warnValue" : ""}>{high}</strong><small>Disclosed ratio at or above 50%</small></div><div><span>Counterparties</span><strong>{counterparties}</strong><small>Deduplicated within current coverage</small></div></section>
        <div className="publicGrid"><section className="publicPanel timelinePanel"><div className="publicPanelHead"><div><h2>Pledge event timeline</h2><p>Reverse chronological order with direct links to connected entities and evidence.</p></div><span>{events.length} records</span></div><div className="publicTimeline">{sorted.map(row => <article key={`${row.id}-${row.announcementId}`}><time>{row.date}</time><div><div className="timelineTitle"><a href={route("company", row.code)}>{row.name}<small>{row.code}</small></a><span className={`tag ${row.type.includes("解除") ? "release" : row.type.includes("补充") ? "extra" : "new"}`}>{eventType(row.type)}</span></div><p><a href={route("shareholder", row.shareholder)}>{row.shareholder}</a><i> → </i><a href={route("pledgee", row.pledgee)}>{row.pledgee || "Not disclosed"}</a></p><div className="timelineFacts"><span>Amount <b>{row.amount || "—"}</b></span><span>Holder ratio <b>{row.ratio || "—"}</b></span><span>Total shares <b>{row.total || "—"}</b></span></div></div><aside><a href={route("event", row.id || "")}>Evidence →</a>{row.pdfUrl && <a href={row.pdfUrl} target="_blank" rel="noreferrer">Official filing ↗</a>}</aside></article>)}</div></section>
          <aside className="publicAside"><section className="publicPanel signalPanel"><div className="publicPanelHead"><div><h2>Diligence signals</h2><p>Based only on currently covered disclosures.</p></div></div><div className="signalRows"><div><span>Supplemental pledges</span><b className={supplemental ? "riskValue" : "safeValue"}>{supplemental || "None found"}</b></div><div><span>High-ratio disclosures</span><b className={high ? "warnValue" : "safeValue"}>{high || "None found"}</b></div><div><span>Pledge releases</span><b>{releases}</b></div><div><span>Relationship breadth</span><b>{counterparties} counterparties</b></div></div><p className="publicDisclaimer">Signals determine review priority only. Outstanding pledged shares must be reconciled against holdings, releases and the latest official filing.</p></section><section className="reportCard"><p className="eyebrow">PROFESSIONAL RESEARCH</p><h2>Shareholder financing risk report</h2><ul><li>Event-by-event pledge reconciliation</li><li>Pledgee concentration analysis</li><li>Supplemental pledge and control-risk clues</li><li>Private-credit diligence checklist</li><li>PDF / Excel research package</li></ul><a className="reportCardLink" href="/en/pricing">View research access →</a><small>Coverage boundaries remain explicit in every report.</small></section><button className="printSummary" onClick={() => window.print()}>Print free summary</button></aside>
        </div>
      </>}
      <footer className="publicFooter"><span>Official public disclosures only. Not investment advice or a credit decision.</span><span>Pledge Radar · Mainland China A shares</span></footer>
    </div>
  </main>;
}
