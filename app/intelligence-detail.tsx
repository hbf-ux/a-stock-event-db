"use client";

import { useEffect, useMemo, useState } from "react";

type Kind = "company" | "shareholder" | "pledgee" | "event";
type EventRow = { id?: string; announcementId?: string; date: string; code: string; name: string; shareholder: string; pledgee: string; amount: string; ratio: string; total: string; type: string; source: string; pdfUrl?: string; confidence?: number; parserVersion?: string; sha256?: string };

const kindLabel: Record<Kind, string> = { company: "上市公司", shareholder: "融资股东", pledgee: "质权人", event: "质押事件" };

export default function IntelligenceDetail({ kind, entityKey }: { kind: Kind; entityKey: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const parameter = kind === "company" ? "stock" : kind === "event" ? "id" : kind;
    void fetch(`/api/events?${parameter}=${encodeURIComponent(entityKey)}&limit=500`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("情报数据暂不可用"); return response.json() as Promise<{ data: EventRow[] }>; })
      .then((payload) => setEvents(payload.data || []))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [entityKey, kind]);

  const percent = (value?: string) => Number((value || "").replace(/[^0-9.]/g, "")) || 0;
  const title = kind === "company" ? (events[0]?.name || entityKey) : kind === "event" ? (events[0] ? `${events[0].name} · ${events[0].type}` : `事件 ${entityKey}`) : entityKey;
  const sorted = useMemo(() => [...events].sort((a, b) => b.date.localeCompare(a.date) || Number(b.id || 0) - Number(a.id || 0)), [events]);
  const supplemental = events.filter((row) => row.type.includes("补充")).length;
  const releases = events.filter((row) => row.type.includes("解除")).length;
  const high = events.filter((row) => Math.max(percent(row.ratio), percent(row.total)) >= 50).length;
  const companies = new Set(events.map((row) => row.code)).size;
  const shareholders = new Set(events.map((row) => row.shareholder).filter(Boolean)).size;
  const pledgees = new Set(events.map((row) => row.pledgee).filter(Boolean)).size;
  const riskScore = Math.min(100, supplemental * 18 + high * 12 + Math.max(0, events.length - releases) * 2);
  const riskLabel = riskScore >= 65 ? "重点核查" : riskScore >= 35 ? "持续观察" : "常规跟进";
  const latest = sorted[0]?.date || "—";
  const first = sorted[sorted.length - 1]?.date || "—";

  useEffect(() => { document.title = `${title}｜质押雷达`; }, [title]);

  const submitReport = async () => {
    const response = await fetch("/api/subscribe-interest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, plan: "enterprise" }) });
    if (response.ok) setSubmitted(true); else setError("登记失败，请稍后重试");
  };

  return <main className="publicIntelPage">
    <header className="publicHeader"><a className="publicBrand" href="/"><span>质</span><b>质押雷达<small>A股股东融资风险情报</small></b></a><nav><a href="/">即时情报</a><a href="/#events">质押事件</a><button onClick={() => setShowReport(true)}>获取完整报告</button></nav></header>
    <div className="publicWrap">
      <div className="publicBreadcrumb"><a href="/">首页</a><span>/</span><span>{kindLabel[kind]}</span><span>/</span><b>{title}</b></div>
      <section className="entityHero"><div><p className="eyebrow">VERIFIABLE PLEDGE INTELLIGENCE</p><div className="entityTitle"><h1>{title}</h1><span>{kindLabel[kind]}</span></div><p>基于官方公开披露整理。每条事件均保留公告来源、原文链接和解析审计信息。</p><div className="entityMeta"><span><i></i>数据已核验</span><span>最新披露 {latest}</span><span>历史覆盖 {first} 至 {latest}</span></div></div><div className={`publicScore ${riskScore >= 65 ? "high" : riskScore >= 35 ? "watch" : "normal"}`}><small>风险筛选评分</small><strong>{riskScore}</strong><b>{riskLabel}</b><em>用于尽调排序，不代表信用结论</em></div></section>
      {loading ? <section className="publicState">正在读取官方披露数据…</section> : error && !events.length ? <section className="publicState error">{error}</section> : !events.length ? <section className="publicState">暂未找到该主体的已核验质押事件。</section> : <>
        <section className="publicMetrics"><div><span>历史事件</span><strong>{events.length}</strong><small>已结构化</small></div><div><span>补充质押</span><strong className={supplemental ? "riskValue" : ""}>{supplemental}</strong><small>重点融资压力信号</small></div><div><span>高比例事件</span><strong className={high ? "warnValue" : ""}>{high}</strong><small>披露比例达到 50%</small></div><div><span>{kind === "pledgee" ? "涉及公司" : kind === "shareholder" ? "涉及质权人" : "涉及股东"}</span><strong>{kind === "pledgee" ? companies : kind === "shareholder" ? pledgees : shareholders}</strong><small>按名称去重</small></div></section>
        <div className="publicGrid"><section className="publicPanel timelinePanel"><div className="publicPanelHead"><div><h2>质押事件时间线</h2><p>按公告日期倒序，点击主体可继续查看关系情报</p></div><span>{events.length} 条记录</span></div><div className="publicTimeline">{sorted.map((row) => <article key={`${row.id}-${row.announcementId}`}><time>{row.date}</time><div><div className="timelineTitle"><a href={`/company/${encodeURIComponent(row.code)}`}>{row.name}<small>{row.code}</small></a><span className={`tag ${row.type.includes("解除") ? "release" : row.type.includes("补充") ? "extra" : "new"}`}>{row.type}</span></div><p><a href={`/shareholder/${encodeURIComponent(row.shareholder)}`}>{row.shareholder}</a><i> → </i><a href={`/pledgee/${encodeURIComponent(row.pledgee)}`}>{row.pledgee}</a></p><div className="timelineFacts"><span>数量 <b>{row.amount || "—"}</b></span><span>占其持股 <b>{row.ratio || "—"}</b></span><span>占总股本 <b>{row.total || "—"}</b></span></div></div><aside><a href={`/event/${row.id}`}>事件详情 →</a>{row.pdfUrl && <a href={row.pdfUrl} target="_blank" rel="noreferrer">官方原文 ↗</a>}</aside></article>)}</div></section>
          <aside className="publicAside"><section className="publicPanel signalPanel"><div className="publicPanelHead"><div><h2>尽调信号</h2><p>基于当前覆盖范围</p></div></div><div className="signalRows"><div><span>补充质押</span><b className={supplemental ? "riskValue" : "safeValue"}>{supplemental ? `${supplemental} 次` : "未发现"}</b></div><div><span>高比例披露</span><b className={high ? "warnValue" : "safeValue"}>{high ? `${high} 条` : "未发现"}</b></div><div><span>解除质押</span><b>{releases} 次</b></div><div><span>关系集中度</span><b>{pledgees <= 1 ? "单一质权人" : `${pledgees} 家质权人`}</b></div></div><p className="publicDisclaimer">上述信号仅用于确定核查优先级。当前存量质押需结合持股基数、解除记录和最新公告逐笔确认。</p></section><section className="reportCard"><p className="eyebrow">PROFESSIONAL REPORT</p><h2>完整股东融资风控报告</h2><ul><li>历史质押与解除逐笔核对</li><li>质权人关系及集中度分析</li><li>补充质押与控制权风险线索</li><li>资方重点核查清单</li><li>可下载 PDF / Excel</li></ul><button onClick={() => setShowReport(true)}>获取完整报告 →</button><small>内测预约，不会产生扣费</small></section><button className="printSummary" onClick={() => window.print()}>打印免费摘要</button></aside>
        </div>
      </>}
      <footer className="publicFooter"><span>数据来源于官方公开披露，仅供研究参考，不构成投资或授信建议。</span><span>质押雷达 · 原文可溯 · 持续更新</span></footer>
    </div>
    {showReport && <div className="reportOverlay" onClick={() => setShowReport(false)}><section className="reportDialog" onClick={(event) => event.stopPropagation()}><button className="reportClose" onClick={() => setShowReport(false)}>×</button>{submitted ? <div className="reportSuccess"><span>✓</span><h2>需求已登记</h2><p>我们会根据该主体的历史覆盖和报告准备情况与你联系。当前不会产生任何费用。</p><button onClick={() => setShowReport(false)}>返回情报页面</button></div> : <><p className="eyebrow">FULL DUE DILIGENCE REPORT</p><h2>获取「{title}」完整报告</h2><p>完整报告面向 FA、资方和上市公司融资机构，提供可追溯的融资历史、关系分析与重点核查清单。</p><div className="reportBoundary"><div><b>免费摘要</b><span>公开事件时间线</span><span>基础风险信号</span><span>官方公告原文</span></div><div><b>完整报告</b><span>全历史逐笔复核</span><span>质权人集中度</span><span>控制权风险线索</span><span>PDF / Excel 核查底稿</span></div></div><label>联系邮箱<input type="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label><button className="reportSubmit" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => void submitReport()}>预约获取完整报告</button><small>内测阶段仅登记需求，不接入支付，也不会自动扣费。</small></>}</section></div>}
  </main>;
}
