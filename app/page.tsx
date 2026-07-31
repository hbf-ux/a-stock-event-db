"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type EventRow = { id?: string; announcementId?: string; date: string; code: string; name: string; shareholder: string; pledgee: string; amount: string; ratio: string; total: string; type: string; source: string; pdfUrl?: string };
type AnnouncementRow = { announcementId: string; stockCode: string; stockName: string; title: string; announceDate: string; pdfUrl?: string; source: string; md5: string; sha256?: string; parseStatus: string; parseAttempts?: number; lastError?: string };
type ReviewRow = { id: number; announcementId: string; reason: string; payload: string; status: string; stockCode: string; stockName: string; title: string; announceDate: string; pdfUrl?: string };
type ReviewForm = { shareholder: string; pledgee: string; amount: string; amountText: string; pledgeRatio: string; totalRatio: string; type: string };
type SyncRun = { id: number; source: string; startedAt: string; finishedAt?: string; status: string; announcementsFound: number; eventsCreated: number; failures: number; message?: string };
type StatsData = { daily: { date: string; announcements: number; parsed: number }[]; eventTypes: { name: string; value: number }[]; pledgees: { name: string; value: number; amount: number }[]; statuses: { name: string; value: number }[] };
type Health = { stats?: { announcements?: number; events?: number; pending_reviews?: number } };
type ProfileData = { stock: string; summary?: { name?: string; events?: number; pledged_amount?: number; latest_date?: string } | null; types: { type: string; count: number }[]; shareholders: { shareholder: string; events: number; amount: number; latest_date: string }[]; history: { date: string; type: string; amount: string; ratio?: string; total?: string; shareholder: string; pledgee: string; announcementId: string }[] };

const statusText: Record<string, string> = { queued: "待归档", archived: "待解析", parsed: "已解析", pending: "待处理", review: "待审核", rejected: "已驳回" };

function ReviewPanel({ reviews, onOpen, onReprocess, reprocessing }: { reviews: ReviewRow[]; onOpen: (review: ReviewRow) => void; onReprocess: () => void; reprocessing: boolean }) {
  const pending = reviews.filter((row) => row.status === "pending");
  return <section className="panel reviewPanel">
    <div className="panelHead"><div><h2>人工审核工作台</h2><span>自动解析缺失关键字段的公告将在这里等待补全</span></div><div className="panelHeadActions"><button className="secondary" disabled={reprocessing || pending.length === 0} onClick={onReprocess}>{reprocessing ? "重跑中…" : "↻ 重跑 OCR"}</button><span className="tag extra">{pending.length} 条待处理</span></div></div>
    <div className="resultMeta">审核通过后写入结构化事件库；驳回记录保留完整审计轨迹</div>
    <div className="tableWrap"><table><thead><tr><th>公告日期</th><th>股票</th><th>公告标题</th><th>异常原因</th><th>状态</th><th></th></tr></thead><tbody>
      {reviews.map((row) => <tr key={row.id}><td className="mono">{row.announceDate}</td><td><b>{row.stockName}</b><small>{row.stockCode}</small></td><td title={row.title}>{row.title}</td><td title={row.reason}>{row.reason}</td><td><span className={`tag ${row.status === "pending" ? "extra" : row.status === "approved" ? "release" : "new"}`}>{row.status === "pending" ? "待审核" : row.status === "approved" ? "已通过" : "已驳回"}</span></td><td>{row.status === "pending" ? <button className="detail" onClick={() => onOpen(row)}>补全字段 ↗</button> : <span className="muted">已处理</span>}</td></tr>)}
      {!reviews.length && <tr><td colSpan={6} className="empty">当前没有需要人工审核的公告。</td></tr>}
    </tbody></table></div>
    <div className="pagination"><span>共 {reviews.length} 条审核记录</span></div>
  </section>;
}

function LogsPanel({ runs }: { runs: SyncRun[] }) {
  const statusLabel: Record<string, string> = { running: "运行中", completed: "成功", completed_with_errors: "部分失败", failed: "失败" };
  return <section className="panel logsPanel"><div className="panelHead"><div><h2>系统运行日志</h2><span>公告同步与 PDF 解析任务的执行记录</span></div><span className="tag release">最近 {runs.length} 次</span></div><div className="tableWrap"><table><thead><tr><th>开始时间</th><th>任务</th><th>状态</th><th>处理公告</th><th>生成事件</th><th>失败</th><th>运行结果</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td className="mono">{new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false })}</td><td><b>{run.source === "pdf-parser" ? "PDF 解析" : "官方公告同步"}</b><small>任务 #{run.id}</small></td><td><span className={`tag ${run.status === "completed" ? "release" : run.status === "failed" ? "new" : "extra"}`}>{statusLabel[run.status] || run.status}</span></td><td className="mono">{run.announcementsFound}</td><td className="mono">{run.eventsCreated}</td><td className={run.failures ? "failCount mono" : "mono"}>{run.failures}</td><td title={run.message}>{run.message || "—"}</td></tr>)}{!runs.length && <tr><td colSpan={7} className="empty">尚无运行记录；同步公告或处理待解析任务后会自动记录。</td></tr>}</tbody></table></div><div className="pagination"><span>日志按时间倒序排列</span></div></section>;
}

function RadarPanel({ events, feedEvents, announcements, stats, runs, onProfile, watchlist, onToggleWatch }: { events: EventRow[]; feedEvents: EventRow[]; announcements: AnnouncementRow[]; stats: StatsData; runs: SyncRun[]; onProfile: (stock: string) => void; watchlist: string[]; onToggleWatch: (stock: string) => void }) {
  const feed = [...feedEvents].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const recentAnnouncements = announcements.filter((row) => row.parseStatus !== "parsed").slice(0, 4);
  const highAttention = feed.filter((row) => /[5-9]\d/.test(row.ratio) || /[5-9]\d/.test(row.total)).length;
  const lastRun = runs.find((run) => run.status === "completed" || run.status === "completed_with_errors");
  const lastRunAt = lastRun?.finishedAt || lastRun?.startedAt;
  const freshness = lastRunAt ? Math.max(0, Math.round((Date.now() - new Date(lastRunAt).getTime()) / 60000)) : null;
  const structuredRate = announcements.length ? Math.round((events.length / announcements.length) * 100) : 0;
  const riskLevel = highAttention >= 3 ? "高" : highAttention > 0 ? "中" : "低";
  return <div className="radarHome"><section className="radarHero"><div><p className="eyebrow">A-SHARE PLEDGE RADAR · LAST 24H</p><h2>质押情报，先看变化</h2><p>官方公告发布后自动归档，按事件时间流展示最新质押、解除和补充质押消息。</p></div><div className="radarPulse"><i></i><span>数据持续更新</span><small>以官方披露为准</small></div></section><div className="radarMetrics"><div><span>24小时事件</span><strong>{feed.length}</strong><small>已结构化</small></div><div><span>涉及公司</span><strong>{new Set(feed.map((row) => row.code)).size}</strong><small>只</small></div><div><span>高关注信号</span><strong>{highAttention}</strong><small>按比例规则</small></div><div><span>待核验公告</span><strong>{recentAnnouncements.length}</strong><small>需要人工确认</small></div></div><section className="radarFeed panel"><div className="panelHead"><div><h2>最新质押情报</h2><span>按公告日期倒序 · 每条记录可追溯到原文</span></div><span className="tag release">LIVE FEED</span></div><div className="feedList">{feed.map((row) => <article className="feedCard" key={`${row.announcementId}-${row.id}`}><div className="feedTime">{row.date}<small>{row.source}</small></div><div className="feedMain"><div><button className="stockLink" onClick={() => onProfile(row.code)}><b>{row.name} <small>{row.code}</small></b></button><p>{row.shareholder} {row.type}</p></div><div className="feedFacts"><span>数量 <b>{row.amount}</b></span><span>占其持股 <b>{row.ratio || "—"}</b></span><span>占总股本 <b>{row.total || "—"}</b></span></div></div><div className="feedActions"><button className={`watchButton ${watchlist.includes(row.code) ? "watched" : ""}`} onClick={() => onToggleWatch(row.code)}>{watchlist.includes(row.code) ? "★ 已关注" : "☆ 关注"}</button><span className={`signal ${/[5-9]\d/.test(row.ratio) || /[5-9]\d/.test(row.total) ? "attention" : "normal"}`}>{/[5-9]\d/.test(row.ratio) || /[5-9]\d/.test(row.total) ? "高关注" : "已核验"}</span>{row.pdfUrl && <button className="detail" onClick={() => window.open(row.pdfUrl, "_blank", "noopener,noreferrer")}>查看原文 ↗</button>}</div></article>)}{!feed.length && <div className="empty">最近暂无已结构化事件；新公告会自动出现在这里。</div>}</div></section><section className="radarLower"><div className="panel radarWatch"><div className="panelHead"><div><h2>待核验公告</h2><span>暂不把不完整字段当作正式事件</span></div></div>{recentAnnouncements.map((row) => <div className="watchRow" key={row.announcementId}><span>{row.announceDate}</span><b>{row.stockName}</b><p>{row.title}</p><em>待审核</em></div>)}{!recentAnnouncements.length && <div className="empty">暂无待核验公告</div>}</div><div className="panel radarInsight"><div className="panelHead"><div><h2>数据可信度</h2><span>解析与来源状态</span></div></div><div className="trustScore"><strong>{events.length ? Math.round((events.length / Math.max(announcements.length, 1)) * 100) : 0}%</strong><span>公告→结构化事件</span></div><p>结构化事件只展示通过字段完整性校验的记录；原文链接、公告编号和哈希均保留。</p><button className="secondary" onClick={() => window.dispatchEvent(new CustomEvent("open-announcements"))}>查看全部公告</button></div></section></div>;
}

function RiskBrief({ events, feedEvents, announcements, runs }: { events: EventRow[]; feedEvents: EventRow[]; announcements: AnnouncementRow[]; runs: SyncRun[] }) {
  const high = feedEvents.filter((row) => /[5-9]\d/.test(row.ratio) || /[5-9]\d/.test(row.total)).length;
  const last = runs.find((run) => run.status === "completed" || run.status === "completed_with_errors");
  const lastAt = last?.finishedAt || last?.startedAt;
  const mins = lastAt ? Math.max(0, Math.round((Date.now() - new Date(lastAt).getTime()) / 60000)) : null;
  const rate = announcements.length ? Math.round((events.length / announcements.length) * 100) : 0;
  return <section className="riskBrief panel"><div className="panelHead"><div><h2>今日风险简报</h2><span>用四个信号快速判断数据是否值得跟进</span></div><span className="tag release">RESEARCH VIEW</span></div><div className="riskBriefGrid"><div><span>最新同步</span><strong>{mins === null ? "—" : mins < 1 ? "刚刚" : `${mins} 分钟前`}</strong><small>{lastAt ? `完成于 ${new Date(lastAt).toLocaleString("zh-CN", { hour12: false })}` : "尚未记录同步"}</small></div><div><span>高关注事件</span><strong className={high ? "riskValue" : ""}>{high}</strong><small>{high ? "质押比例达到 50% 以上" : "近 24 小时暂无高比例信号"}</small></div><div><span>结构化覆盖率</span><strong>{rate}%</strong><small>{events.length} 条事件 / {announcements.length} 条公告</small></div><div><span>当前风险温度</span><strong className={high >= 3 ? "riskValue" : high ? "warnValue" : "safeValue"}>{high >= 3 ? "高" : high ? "中" : "低"}</strong><small>仅作筛选提示，不构成投资建议</small></div></div></section>;
}

function ProfileTrend({ history }: { history: ProfileData["history"] }) {
  const points = history.slice(0, 8).reverse();
  const score = (row: ProfileData["history"][number]) => Math.min(100, Math.max(8, Number((row.total || row.ratio || "0").replace(/[^0-9.]/g, "")) || 8));
  const max = Math.max(...points.map(score), 1);
  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  const delta = latest && previous ? score(latest) - score(previous) : 0;
  return <div className="profileTrend"><div className="trendSummary"><div><span>风险趋势</span><strong className={delta > 0 ? "trendUp" : delta < 0 ? "trendDown" : "trendFlat"}>{delta > 0 ? "上升" : delta < 0 ? "回落" : "平稳"}</strong></div><small>{points.length ? `基于最近 ${points.length} 条已解析事件` : "暂无足够历史数据"}</small></div>{points.length ? <div className="trendBars" aria-label="公司质押风险趋势"><div className="trendAxis"><span>高</span><span>低</span></div>{points.map((row) => <div className="trendPoint" key={`${row.announcementId}-${row.date}`} title={`${row.date} ${row.type}`}><i style={{ height: `${Math.max(10, (score(row) / max) * 100)}%` }}></i><small>{row.date.slice(5)}</small></div>)}</div> : <div className="empty">暂时无法形成趋势</div>}</div>;
}

function WatchlistPanel({ events, watchlist, onProfile, onToggleWatch }: { events: EventRow[]; watchlist: string[]; onProfile: (stock: string) => void; onToggleWatch: (stock: string) => void }) {
  const rows = events.filter((row) => watchlist.includes(row.code)).slice(0, 100);
  return <section className="panel watchlistPanel"><div className="panelHead"><div><h2>我的关注</h2><span>关注公司的最新质押变化</span></div><span className="tag extra">{watchlist.length} 家公司</span></div>{watchlist.length === 0 ? <div className="watchEmpty"><strong>还没有关注股票</strong><p>在质押雷达中点击“关注”，这里会持续汇总最新变化。</p></div> : <div className="watchGrid">{watchlist.map((stock) => { const latest = rows.find((row) => row.code === stock); return <article className="watchCard" key={stock}><div className="watchCardTop"><button className="stockLink" onClick={() => onProfile(stock)}><b>{latest?.name || stock}</b><small>{stock}</small></button><button className="watchButton watched" onClick={() => onToggleWatch(stock)}>★</button></div>{latest ? <><p>{latest.shareholder} · {latest.type}</p><strong>{latest.amount}</strong><small>{latest.date} · {latest.ratio || "比例待核验"}</small></> : <p>暂无近期结构化事件</p>}</article>; })}</div>}</section>;
}

function AlertsPanel({ feedEvents, watchlist, onProfile }: { feedEvents: EventRow[]; watchlist: string[]; onProfile: (stock: string) => void }) {
  const alerts = feedEvents.filter((row) => watchlist.includes(row.code));
  return <section className="panel alertsPanel"><div className="panelHead"><div><h2>提醒中心</h2><span>关注股票在最近24小时的质押变化</span></div><span className="tag extra">{alerts.length} 条新提醒</span></div>{alerts.length ? <div className="alertList">{alerts.map((row) => <article key={`${row.announcementId}-${row.id}`} className="alertRow"><span className="alertDot"></span><div><button className="stockLink" onClick={() => onProfile(row.code)}><b>{row.name} · {row.code}</b></button><p>{row.shareholder} {row.type}，数量 {row.amount}</p><small>{row.date} · {row.source}</small></div><span className="tag new">查看画像</span></article>)}</div> : <div className="watchEmpty"><strong>暂无新提醒</strong><p>关注股票出现新的质押、解除或补充质押公告后，会出现在这里。</p></div>}</section>;
}

function DashboardPanel({ stats, runs }: { stats: StatsData; runs: SyncRun[] }) {
  const maxDaily = Math.max(...stats.daily.map((row) => row.announcements),1);
  const maxPledgee = Math.max(...stats.pledgees.map((row) => row.value),1);
  return <div className="dashboardGrid"><section className="panel trendPanel"><div className="panelHead"><div><h2>近 14 日公告趋势</h2><span>官方公告数量与已解析数量</span></div></div><div className="barChart">{stats.daily.map((row) => <div className="barItem" key={row.date}><div className="barTrack"><i style={{ height:`${Math.max((row.announcements/maxDaily)*100,4)}%` }}></i><b style={{ height:`${Math.max((row.parsed/maxDaily)*100,0)}%` }}></b></div><strong>{row.announcements}</strong><span>{row.date.slice(5)}</span></div>)}{!stats.daily.length && <p className="chartEmpty">同步公告后显示趋势</p>}</div></section><section className="panel distributionPanel"><div className="panelHead"><div><h2>解析状态分布</h2><span>公告生产链路健康度</span></div></div><div className="statusList">{stats.statuses.map((row) => <div key={row.name}><span className={`statusDot ${row.name}`}></span><b>{statusText[row.name] || row.name}</b><strong>{row.value}</strong></div>)}{!stats.statuses.length && <p className="chartEmpty">暂无状态数据</p>}</div></section><section className="panel pledgeePanel"><div className="panelHead"><div><h2>主要质权人</h2><span>按结构化事件数量排名</span></div></div><div className="rankList">{stats.pledgees.map((row,index) => <div key={row.name}><em>{index+1}</em><span title={row.name}>{row.name}</span><i><b style={{width:`${(row.value/maxPledgee)*100}%`}}></b></i><strong>{row.value}</strong></div>)}{!stats.pledgees.length && <p className="chartEmpty">解析事件后显示排名</p>}</div></section><section className="panel recentPanel"><div className="panelHead"><div><h2>最近运行</h2><span>同步与解析任务</span></div></div><div className="recentRuns">{runs.slice(0,5).map((run) => <div key={run.id}><span className={`runState ${run.status}`}></span><p><b>{run.source === "pdf-parser" ? "PDF 解析" : "公告同步"}</b><small>{new Date(run.startedAt).toLocaleString("zh-CN",{hour12:false})}</small></p><strong>{run.status === "completed" ? "成功" : run.status === "failed" ? "失败" : "已完成"}</strong></div>)}{!runs.length && <p className="chartEmpty">暂无运行记录</p>}</div></section></div>;
}

export default function Home() {
  const [view, setView] = useState<"dashboard" | "watchlist" | "alerts" | "announcements" | "events" | "reviews" | "logs">("dashboard");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [events, setEvents] = useState<EventRow[]>([]);
  const [feedEvents, setFeedEvents] = useState<EventRow[]>([]);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [statsData, setStatsData] = useState<StatsData>({ daily:[],eventTypes:[],pledgees:[],statuses:[] });
  const [editingReview, setEditingReview] = useState<ReviewRow | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm>({ shareholder: "", pledgee: "", amount: "", amountText: "", pledgeRatio: "", totalRatio: "", type: "新增质押" });
  const [health, setHealth] = useState<Health>({});
  const [notice, setNotice] = useState("");
  const [state, setState] = useState<"loading" | "online" | "error">("loading");
  const [syncing, setSyncing] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [exportFormat, setExportFormat] = useState<"xls" | "csv" | "json">("xls");
  const [showPlans, setShowPlans] = useState(false);
  const [plan] = useState<"free" | "pro">("free");
  const [interestEmail, setInterestEmail] = useState("");

  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 3500); };
  const loadAll = useCallback(async () => {
    try {
      const [eventResponse, feedResponse, announcementResponse, healthResponse, reviewResponse, runResponse, statsResponse] = await Promise.all([
        fetch("/api/events", { cache: "no-store" }),
        fetch("/api/feed?hours=24&limit=50", { cache: "no-store" }),
        fetch("/api/announcements", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/reviews", { cache: "no-store" }),
        fetch("/api/sync-runs", { cache: "no-store" }),
        fetch("/api/stats", { cache: "no-store" }),
      ]);
      if (!eventResponse.ok || !feedResponse.ok || !announcementResponse.ok || !healthResponse.ok || !reviewResponse.ok || !runResponse.ok || !statsResponse.ok) throw new Error("API unavailable");
      const eventPayload = await eventResponse.json() as { data: EventRow[] };
      const announcementPayload = await announcementResponse.json() as { data: AnnouncementRow[] };
      setEvents(eventPayload.data);
      setFeedEvents((await feedResponse.json() as { data: EventRow[] }).data);
      setAnnouncements(announcementPayload.data);
      setReviews((await reviewResponse.json() as { data: ReviewRow[] }).data);
      setSyncRuns((await runResponse.json() as { data: SyncRun[] }).data);
      setStatsData(await statsResponse.json() as StatsData);
      setHealth(await healthResponse.json() as Health);
      setState("online");
      if (!eventPayload.data.length && announcementPayload.data.length) setView("announcements");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => { try { const saved = window.localStorage.getItem("stock-event-watchlist"); if (saved) setWatchlist(JSON.parse(saved) as string[]); } catch {} }, []);

  const filteredAnnouncements = useMemo(() => announcements.filter((row) => {
    const text = `${row.stockCode}${row.stockName}${row.title}`.toLowerCase();
    return (!date || row.announceDate === date) && (!query || text.includes(query.toLowerCase()));
  }), [announcements, date, query]);
  const filteredEvents = useMemo(() => events.filter((row) => {
    const text = `${row.code}${row.name}${row.shareholder}${row.pledgee}`.toLowerCase();
    return (!date || row.date === date) && (!query || text.includes(query.toLowerCase()));
  }), [events, date, query]);

  const sync = async () => {
    setSyncing(true);
    try {
      const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: date || new Date().toISOString().slice(0, 10) }) });
      const result = await response.json() as { announcements_found?: number; announcements_inserted?: number; auto_processing?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || "同步失败");
      await loadAll();
      setView("announcements");
      flash(`同步完成：发现 ${result.announcements_found || 0} 条，新增 ${result.announcements_inserted || 0} 条；后台解析已启动`);
    } catch (error) { flash(error instanceof Error ? error.message : "同步失败"); }
    finally { setSyncing(false); }
  };

  const backfill = async () => {
    setSyncing(true); flash("正在回补近 7 日官方公告…");
    try {
      const response = await fetch("/api/backfill",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({days:7,endDate:date || undefined})});
      const result = await response.json() as { announcements_found?:number;announcements_inserted?:number;failures?:number;error?:string };
      if (!response.ok) throw new Error(result.error || "历史回补失败");
      await loadAll(); setView("announcements");
      flash(`回补完成：发现 ${result.announcements_found || 0} 条，新增 ${result.announcements_inserted || 0} 条，失败日期 ${result.failures || 0} 个`);
    } catch (error) { flash(error instanceof Error ? error.message : "历史回补失败"); }
    finally { setSyncing(false); }
  };

  const archive = async (row: AnnouncementRow) => {
    flash(`正在下载并解析 ${row.stockName} 的公告 PDF…`);
    const response = await fetch(`/api/announcements/${row.announcementId}/process`, { method: "POST" });
    const result = await response.json() as { status?: string; missing?: string[]; error?: string };
    if (response.ok) { await loadAll(); flash(result.status === "parsed" ? "解析完成，质押事件已入库" : `PDF 已归档，缺少 ${result.missing?.join("、") || "必要字段"}，已进入人工审核`); }
    else flash(result.error || "PDF 处理失败，请稍后重试");
  };

  const processPending = async () => {
    setSyncing(true);
    flash("正在处理最近 3 条待解析公告…");
    try {
      const response = await fetch("/api/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 3 }) });
      const result = await response.json() as { processed?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "处理失败");
      await loadAll();
      flash(`本轮处理完成：${result.processed || 0} 条公告`);
    } catch (error) { flash(error instanceof Error ? error.message : "处理失败"); }
    finally { setSyncing(false); }
  };

  const reprocessReviews = async () => {
    setReprocessing(true);
    try {
      const response = await fetch("/api/reprocess-reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 5 }) });
      const result = await response.json() as { processed?: number; results?: { status?: string; ocr_error?: string }[]; error?: string };
      if (!response.ok) throw new Error(result.error || "重跑失败");
      await loadAll();
      const quota = result.results?.some((item) => item.ocr_error?.includes("credit_balance_exhausted"));
      flash(quota ? "OCR 已重跑，但 OpenAI 账户余额不足；记录已保留在审核队列" : `OCR 重跑完成：${result.processed || 0} 条`);
    } catch (error) { flash(error instanceof Error ? error.message : "OCR 重跑失败"); }
    finally { setReprocessing(false); }
  };

  const openReview = (review: ReviewRow) => {
    let payload: Partial<ReviewForm> = {};
    try { payload = JSON.parse(review.payload) as Partial<ReviewForm>; } catch { payload = {}; }
    setReviewForm({ shareholder: payload.shareholder || "", pledgee: payload.pledgee || "", amount: payload.amount ? String(payload.amount) : "", amountText: payload.amountText || "", pledgeRatio: payload.pledgeRatio || "", totalRatio: payload.totalRatio || "", type: payload.type || "新增质押" });
    setEditingReview(review);
  };

  const resolveReview = async (status: "approved" | "rejected") => {
    if (!editingReview) return;
    const response = await fetch(`/api/reviews/${editingReview.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, ...reviewForm, amount: Number(reviewForm.amount), resolution: status === "approved" ? "人工补全并核验" : "人工判定非有效质押事件" }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { flash(result.error || "审核保存失败"); return; }
    setEditingReview(null);
    await loadAll();
    flash(status === "approved" ? "审核通过，事件已写入数据库" : "该公告已标记为不入库");
  };

  const exportData = () => {
    if (plan === "free" && exportFormat !== "csv") { setShowPlans(true); flash("专业版支持 Excel 与 JSON 导出"); return; }
    window.location.href = `/api/export?format=${exportFormat}`;
    flash(`正在导出 ${exportFormat === "xls" ? "Excel" : exportFormat.toUpperCase()} 文件`);
  };

  const openProfile = async (stock: string) => {
    try { const response = await fetch(`/api/profile?stock=${encodeURIComponent(stock)}`, { cache: "no-store" }); if (!response.ok) throw new Error("画像暂不可用"); setProfile(await response.json() as ProfileData); } catch (error) { flash(error instanceof Error ? error.message : "画像加载失败"); }
  };
  const toggleWatch = (stock: string) => { const next = watchlist.includes(stock) ? watchlist.filter((item) => item !== stock) : [...watchlist, stock]; setWatchlist(next); try { window.localStorage.setItem("stock-event-watchlist", JSON.stringify(next)); } catch {} flash(next.includes(stock) ? `已关注 ${stock}` : `已取消关注 ${stock}`); };
  const submitInterest = async () => { const response = await fetch("/api/subscribe-interest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: interestEmail, plan: "pro" }) }); const result = await response.json() as { ok?: boolean; error?: string; message?: string }; if (!response.ok) { flash(result.error || "提交失败"); return; } setInterestEmail(""); flash(result.message || "已登记"); };

  const rawCount = health.stats?.announcements ?? announcements.length;
  const eventCount = health.stats?.events ?? events.length;
  const pendingCount = health.stats?.pending_reviews ?? announcements.filter((row) => row.parseStatus !== "parsed").length;
  const parsedRate = rawCount ? `${((eventCount / rawCount) * 100).toFixed(1)}%` : "0.0%";
  const pageTitle = view === "dashboard" ? "质押雷达" : view === "watchlist" ? "我的关注" : view === "alerts" ? "提醒中心" : view === "announcements" ? "公告中心" : view === "reviews" ? "人工审核" : view === "logs" ? "系统日志" : "股权质押";
  const pageDescription = view === "dashboard" ? "基于真实公告与结构化事件的运行概览。" : view === "announcements" ? "真实官方公告已入库；待解析公告保留在审核队列。" : view === "reviews" ? "补全自动解析缺失字段，审核操作全程留痕。" : view === "logs" ? "监控公告同步、PDF 解析与异常处理结果。" : "仅展示字段校验通过的结构化质押事件。";
  const pageEyebrow = view === "dashboard" ? "DATA OVERVIEW" : view === "announcements" ? "OFFICIAL ANNOUNCEMENTS" : view === "reviews" ? "REVIEW QUEUE" : view === "logs" ? "SYSTEM OPERATIONS" : "PLEDGE EVENTS";

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brandMark">事</div><div><strong>A股事件库</strong><span>STOCK EVENT DB</span></div></div>
      <nav><p className="navLabel">工作台</p>
        <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}><i>⌂</i>总览</button>
        <button className={view === "watchlist" ? "active" : ""} onClick={() => setView("watchlist")}><i>★</i>我的关注<em>{watchlist.length}</em></button>
        <button className={view === "alerts" ? "active" : ""} onClick={() => setView("alerts")}><i>●</i>提醒中心<em>{feedEvents.filter((row) => watchlist.includes(row.code)).length}</em></button>
        <button className={view === "announcements" ? "active" : ""} onClick={() => setView("announcements")}><i>▤</i>公告中心</button>
        <button className={view === "events" ? "active" : ""} onClick={() => setView("events")}><i>⌘</i>事件中心</button>
        <button className={view === "reviews" ? "active" : ""} onClick={() => setView("reviews")}><i>✓</i>人工审核<em>{reviews.filter((row) => row.status === "pending").length}</em></button>
        <p className="navLabel second">事件模块</p>
        <button className={view === "events" ? "active" : ""} onClick={() => setView("events")}><i>◇</i>股权质押</button>
        <button onClick={() => flash("增减持模块将在 V2.0 开放")}><i>↗</i>增减持<em>即将上线</em></button>
        <button onClick={() => flash("股票回购模块将在 V2.0 开放")}><i>↻</i>股票回购<em>即将上线</em></button>
      </nav>
      <div className="sideBottom"><button className={view === "logs" ? "active" : ""} onClick={() => setView("logs")}><i>≡</i>系统日志</button><div className="system"><span></span><div><b>{state === "online" ? "数据库在线" : state === "loading" ? "正在连接" : "连接异常"}</b><small>D1 · R2 · Worker API</small></div></div></div>
    </aside>
    <section className="content">
      <header><div className="crumb">{view === "announcements" ? "公告中心 / 官方披露" : "事件中心 / 股权质押"}</div><div className="headerRight"><div className="globalSearch">⌕<input aria-label="全局搜索" placeholder="搜索股票、股东或公告…" value={query} onChange={(e) => setQuery(e.target.value)} /></div><button className="planBadge" onClick={() => setShowPlans(true)}>{plan === "free" ? "免费研究版" : "专业版"}</button><div className="avatar">研</div></div></header>
      <div className="page">
        <div className="titleRow"><div><p className="eyebrow">{pageEyebrow} · {state.toUpperCase()}</p><h1>{pageTitle}</h1><p>{pageDescription}</p></div><div className="actions"><button className="secondary" disabled={syncing} onClick={() => void sync()}>{syncing ? "处理中…" : "↻ 同步公告"}</button>{view === "announcements" && <button className="secondary" disabled={syncing} onClick={() => void backfill()}>↶ 回补 7 日</button>}{view === "announcements" && <button className="secondary" disabled={syncing || pendingCount === 0} onClick={() => void processPending()}>⚙ 处理待解析</button>}<div className="exportGroup"><select aria-label="导出格式" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "xls" | "csv" | "json")}><option value="xls">Excel</option><option value="csv">CSV</option><option value="json">JSON</option></select><button className="primary" onClick={exportData}>⇩ 导出</button></div></div></div>
        <div className="stats"><div><span className="statIcon blue">▥</span><p>已抓取公告</p><strong>{rawCount}</strong><small>官方原始披露</small></div><div><span className="statIcon violet">◇</span><p>结构化质押事件</p><strong>{eventCount}</strong><small>通过完整性校验</small></div><div><span className="statIcon amber">◷</span><p>待解析 / 审核</p><strong>{pendingCount}</strong><small><b className="warn">需处理</b></small></div><div><span className="statIcon green">✓</span><p>当前解析率</p><strong>{parsedRate}</strong><small>事件数 / 公告数</small></div></div>
        {eventCount === 0 && rawCount > 0 && <div className="dataNotice"><b>真实数据不为空：</b>已抓取 {rawCount} 条官方公告，其中 {pendingCount} 条等待 PDF 归档和字段解析。系统不会用不完整字段伪造质押事件。</div>}
        {view === "dashboard" ? <><RiskBrief events={events} feedEvents={feedEvents} announcements={announcements} runs={syncRuns} /><RadarPanel events={events} feedEvents={feedEvents} announcements={announcements} stats={statsData} runs={syncRuns} onProfile={(stock) => void openProfile(stock)} watchlist={watchlist} onToggleWatch={toggleWatch} /></> : view === "watchlist" ? <WatchlistPanel events={events} watchlist={watchlist} onProfile={(stock) => void openProfile(stock)} onToggleWatch={toggleWatch} /> : view === "alerts" ? <AlertsPanel feedEvents={feedEvents} watchlist={watchlist} onProfile={(stock) => void openProfile(stock)} /> : view === "reviews" ? <ReviewPanel reviews={reviews} onOpen={openReview} onReprocess={() => void reprocessReviews()} reprocessing={reprocessing} /> : view === "logs" ? <LogsPanel runs={syncRuns} /> : <section className="panel">
          <div className="panelHead"><div><h2>{view === "announcements" ? "官方公告明细" : "质押事件明细"}</h2><span>{view === "announcements" ? "原始披露层 · 可追溯到官方 PDF" : "结构化事件层 · 已通过字段校验"}</span></div><div className="viewBtns"><button className={view === "announcements" ? "chosen" : ""} onClick={() => setView("announcements")}>原始公告</button><button className={view === "events" ? "chosen" : ""} onClick={() => setView("events")}>结构化事件</button></div></div>
          <div className="filters"><label><span>公告日期</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label className="wide"><span>股票 / 公告 / 相关方</span><input placeholder="输入关键词搜索" value={query} onChange={(e) => setQuery(e.target.value)} /></label><button className="searchBtn">查询</button><button className="reset" onClick={() => { setDate(""); setQuery(""); }}>重置</button></div>
          {view === "announcements" ? <><div className="resultMeta">共找到 <b>{filteredAnnouncements.length}</b> 条真实公告<span>来源：巨潮资讯官方披露</span></div><div className="tableWrap"><table className="announcementTable"><thead><tr><th>公告日期</th><th>股票</th><th>公告标题</th><th>状态</th><th>来源</th><th>哈希</th><th></th></tr></thead><tbody>{filteredAnnouncements.map((row) => <tr key={row.announcementId}><td className="mono">{row.announceDate}</td><td><b>{row.stockName}</b><small>{row.stockCode}</small></td><td title={row.title}>{row.title}</td><td><span className={`tag ${row.parseStatus === "parsed" ? "release" : row.parseStatus === "archived" ? "extra" : "new"}`}>{statusText[row.parseStatus] || row.parseStatus}</span></td><td><span className="sourceDot"></span>{row.source}</td><td className="mono">{row.sha256 ? `${row.sha256.slice(0, 10)}…` : "待归档"}</td><td><button className="detail" onClick={() => row.parseStatus === "queued" ? void archive(row) : window.open(row.pdfUrl, "_blank", "noopener,noreferrer")}>{row.parseStatus === "queued" ? "归档 PDF" : "查看原文"} ↗</button></td></tr>)}{!filteredAnnouncements.length && <tr><td colSpan={7} className="empty">该日期暂无已抓取公告；点击“同步公告”从巨潮资讯获取。</td></tr>}</tbody></table></div></> : <><div className="resultMeta">共找到 <b>{filteredEvents.length}</b> 条结构化事件<span>仅包含字段校验通过的数据</span></div><div className="tableWrap"><table><thead><tr><th>公告日期</th><th>股票</th><th>股东名称</th><th>质权人</th><th>质押数量</th><th>占其持股</th><th>占总股本</th><th>事件类型</th><th>来源</th></tr></thead><tbody>{filteredEvents.map((row) => <tr key={row.announcementId || row.id}><td>{row.date}</td><td><b>{row.name}</b><small>{row.code}</small></td><td>{row.shareholder}</td><td>{row.pledgee}</td><td>{row.amount}</td><td>{row.ratio}</td><td>{row.total}</td><td><span className="tag new">{row.type}</span></td><td>{row.source}</td></tr>)}{!filteredEvents.length && <tr><td colSpan={9} className="empty">已有真实公告，但尚未产生字段完整的质押事件。请先在公告中心归档 PDF。</td></tr>}</tbody></table></div></>}
          <div className="pagination"><span>当前显示 {view === "announcements" ? filteredAnnouncements.length : filteredEvents.length} 条</span></div>
        </section>}
        <footer><span>数据仅供研究参考，不构成投资建议</span><span>公开披露 · 原文可溯 · D1 持久化</span></footer>
      </div>
    </section>
    {editingReview && <div className="overlay" onClick={() => setEditingReview(null)}><aside className="drawer reviewDrawer" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setEditingReview(null)}>×</button><p className="eyebrow">MANUAL REVIEW</p><h2>补全质押事件字段</h2><div className="reviewSource"><b>{editingReview.stockName} · {editingReview.stockCode}</b><span>{editingReview.title}</span><small>{editingReview.reason}</small></div><div className="reviewForm"><label><span>股东名称 *</span><input value={reviewForm.shareholder} onChange={(event) => setReviewForm({ ...reviewForm, shareholder: event.target.value })} /></label><label><span>质权人 *</span><input value={reviewForm.pledgee} onChange={(event) => setReviewForm({ ...reviewForm, pledgee: event.target.value })} /></label><label><span>质押数量（股）*</span><input type="number" min="0" value={reviewForm.amount} onChange={(event) => setReviewForm({ ...reviewForm, amount: event.target.value })} /></label><label><span>数量原文</span><input placeholder="例如：1,000万股" value={reviewForm.amountText} onChange={(event) => setReviewForm({ ...reviewForm, amountText: event.target.value })} /></label><div className="reviewGrid"><label><span>占其持股</span><input placeholder="12.53%" value={reviewForm.pledgeRatio} onChange={(event) => setReviewForm({ ...reviewForm, pledgeRatio: event.target.value })} /></label><label><span>占总股本</span><input placeholder="3.15%" value={reviewForm.totalRatio} onChange={(event) => setReviewForm({ ...reviewForm, totalRatio: event.target.value })} /></label></div><label><span>事件类型</span><select value={reviewForm.type} onChange={(event) => setReviewForm({ ...reviewForm, type: event.target.value })}><option>新增质押</option><option>补充质押</option><option>解除质押</option><option>解除后再质押</option></select></label></div><div className="reviewActions"><button className="secondary danger" onClick={() => void resolveReview("rejected")}>驳回，不入库</button><button className="primary" disabled={!reviewForm.shareholder.trim() || !reviewForm.pledgee.trim() || !Number(reviewForm.amount)} onClick={() => void resolveReview("approved")}>审核通过并入库</button></div></aside></div>}
    {profile && <div className="overlay" onClick={() => setProfile(null)}><aside className="drawer profileDrawer" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setProfile(null)}>×</button><p className="eyebrow">COMPANY PROFILE · {profile.stock}</p><h2>{profile.summary?.name || profile.stock}</h2><div className="profileStats"><div><span>质押事件</span><strong>{profile.summary?.events || 0}</strong></div><div><span>最新日期</span><strong>{profile.summary?.latest_date || "—"}</strong></div></div><h3>风险趋势</h3><ProfileTrend history={profile.history} /><h3>股东与质押轨迹</h3><div className="profileShareholders">{profile.shareholders.map((row) => <div key={row.shareholder}><b>{row.shareholder}</b><span>{row.events} 次 · {row.amount} 股</span></div>)}{!profile.shareholders.length && <p className="empty">暂无结构化历史</p>}</div><h3>最近事件</h3><div className="profileHistory">{profile.history.slice(0, 8).map((row) => <div key={row.announcementId + row.date}><span>{row.date}</span><b>{row.type}</b><small>{row.amount} · {row.pledgee}</small></div>)}</div><p className="planNote">数据来自官方公告，支持原文追溯。专业版将提供更长历史和自选股提醒。</p></aside></div>}
    {showPlans && <div className="overlay" onClick={() => setShowPlans(false)}><aside className="drawer plansDrawer" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setShowPlans(false)}>×</button><p className="eyebrow">RESEARCH PLANS</p><h2>情报工作台</h2><p className="planIntro">免费查看官方公告与结构化事件；专业版面向研究团队提供更高效的筛选与导出。</p><div className="pricingGrid"><div className="priceCard"><span>免费研究版</span><strong>¥0</strong><small>公告浏览 · CSV 导出 · 原文追溯</small><button className="secondary" onClick={() => setShowPlans(false)}>当前方案</button></div><div className="priceCard featured"><span>专业版</span><strong>¥99<small>/月</small></strong><small>Excel/JSON 导出 · 高级筛选 · 历史数据与团队席位</small><input className="interestInput" aria-label="联系邮箱" placeholder="留下邮箱，预约专业版" value={interestEmail} onChange={(event) => setInterestEmail(event.target.value)} /><button className="primary" disabled={!interestEmail.trim()} onClick={() => void submitInterest()}>预约开通</button></div></div><p className="planNote">当前为产品内测阶段，不会产生任何扣费。</p></aside></div>}
    {notice && <div className="toast">✓ {notice}</div>}
  </main>;
}
