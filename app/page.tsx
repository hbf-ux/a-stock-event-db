"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type EventRow = { id?: string; announcementId?: string; date: string; code: string; name: string; shareholder: string; pledgee: string; amount: string; ratio: string; total: string; type: string; source: string; pdfUrl?: string };
type AnnouncementRow = { announcementId: string; stockCode: string; stockName: string; title: string; announceDate: string; pdfUrl?: string; source: string; md5: string; sha256?: string; parseStatus: string };
type ReviewRow = { id: number; announcementId: string; reason: string; payload: string; status: string; stockCode: string; stockName: string; title: string; announceDate: string; pdfUrl?: string };
type ReviewForm = { shareholder: string; pledgee: string; amount: string; amountText: string; pledgeRatio: string; totalRatio: string; type: string };
type SyncRun = { id: number; source: string; startedAt: string; finishedAt?: string; status: string; announcementsFound: number; eventsCreated: number; failures: number; message?: string };
type Health = { stats?: { announcements?: number; events?: number; pending_reviews?: number } };

const statusText: Record<string, string> = { queued: "待归档", archived: "待解析", parsed: "已解析", pending: "待处理" };

function ReviewPanel({ reviews, onOpen }: { reviews: ReviewRow[]; onOpen: (review: ReviewRow) => void }) {
  const pending = reviews.filter((row) => row.status === "pending");
  return <section className="panel reviewPanel">
    <div className="panelHead"><div><h2>人工审核工作台</h2><span>自动解析缺失关键字段的公告将在这里等待补全</span></div><span className="tag extra">{pending.length} 条待处理</span></div>
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

export default function Home() {
  const [view, setView] = useState<"announcements" | "events" | "reviews" | "logs">("announcements");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [events, setEvents] = useState<EventRow[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [editingReview, setEditingReview] = useState<ReviewRow | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm>({ shareholder: "", pledgee: "", amount: "", amountText: "", pledgeRatio: "", totalRatio: "", type: "新增质押" });
  const [health, setHealth] = useState<Health>({});
  const [notice, setNotice] = useState("");
  const [state, setState] = useState<"loading" | "online" | "error">("loading");
  const [syncing, setSyncing] = useState(false);
  const [exportFormat, setExportFormat] = useState<"xls" | "csv" | "json">("xls");

  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 3500); };
  const loadAll = useCallback(async () => {
    try {
      const [eventResponse, announcementResponse, healthResponse, reviewResponse, runResponse] = await Promise.all([
        fetch("/api/events", { cache: "no-store" }),
        fetch("/api/announcements", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/reviews", { cache: "no-store" }),
        fetch("/api/sync-runs", { cache: "no-store" }),
      ]);
      if (!eventResponse.ok || !announcementResponse.ok || !healthResponse.ok || !reviewResponse.ok || !runResponse.ok) throw new Error("API unavailable");
      const eventPayload = await eventResponse.json() as { data: EventRow[] };
      const announcementPayload = await announcementResponse.json() as { data: AnnouncementRow[] };
      setEvents(eventPayload.data);
      setAnnouncements(announcementPayload.data);
      setReviews((await reviewResponse.json() as { data: ReviewRow[] }).data);
      setSyncRuns((await runResponse.json() as { data: SyncRun[] }).data);
      setHealth(await healthResponse.json() as Health);
      setState("online");
      if (!eventPayload.data.length && announcementPayload.data.length) setView("announcements");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

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
    window.location.href = `/api/export?format=${exportFormat}`;
    flash(`正在导出 ${exportFormat === "xls" ? "Excel" : exportFormat.toUpperCase()} 文件`);
  };

  const rawCount = health.stats?.announcements ?? announcements.length;
  const eventCount = health.stats?.events ?? events.length;
  const pendingCount = health.stats?.pending_reviews ?? announcements.filter((row) => row.parseStatus !== "parsed").length;
  const parsedRate = rawCount ? `${((eventCount / rawCount) * 100).toFixed(1)}%` : "0.0%";
  const pageTitle = view === "announcements" ? "公告中心" : view === "reviews" ? "人工审核" : view === "logs" ? "系统日志" : "股权质押";
  const pageDescription = view === "announcements" ? "真实官方公告已入库；待解析公告保留在审核队列。" : view === "reviews" ? "补全自动解析缺失字段，审核操作全程留痕。" : view === "logs" ? "监控公告同步、PDF 解析与异常处理结果。" : "仅展示字段校验通过的结构化质押事件。";
  const pageEyebrow = view === "announcements" ? "OFFICIAL ANNOUNCEMENTS" : view === "reviews" ? "REVIEW QUEUE" : view === "logs" ? "SYSTEM OPERATIONS" : "PLEDGE EVENTS";

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brandMark">事</div><div><strong>A股事件库</strong><span>STOCK EVENT DB</span></div></div>
      <nav><p className="navLabel">工作台</p>
        <button><i>⌂</i>总览</button>
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
      <header><div className="crumb">{view === "announcements" ? "公告中心 / 官方披露" : "事件中心 / 股权质押"}</div><div className="headerRight"><div className="globalSearch">⌕<input aria-label="全局搜索" placeholder="搜索股票、股东或公告…" value={query} onChange={(e) => setQuery(e.target.value)} /></div><div className="avatar">研</div></div></header>
      <div className="page">
        <div className="titleRow"><div><p className="eyebrow">{pageEyebrow} · {state.toUpperCase()}</p><h1>{pageTitle}</h1><p>{pageDescription}</p></div><div className="actions"><button className="secondary" disabled={syncing} onClick={() => void sync()}>{syncing ? "处理中…" : "↻ 同步公告"}</button>{view === "announcements" && <button className="secondary" disabled={syncing || pendingCount === 0} onClick={() => void processPending()}>⚙ 处理待解析</button>}<div className="exportGroup"><select aria-label="导出格式" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "xls" | "csv" | "json")}><option value="xls">Excel</option><option value="csv">CSV</option><option value="json">JSON</option></select><button className="primary" onClick={exportData}>⇩ 导出</button></div></div></div>
        <div className="stats"><div><span className="statIcon blue">▥</span><p>已抓取公告</p><strong>{rawCount}</strong><small>官方原始披露</small></div><div><span className="statIcon violet">◇</span><p>结构化质押事件</p><strong>{eventCount}</strong><small>通过完整性校验</small></div><div><span className="statIcon amber">◷</span><p>待解析 / 审核</p><strong>{pendingCount}</strong><small><b className="warn">需处理</b></small></div><div><span className="statIcon green">✓</span><p>当前解析率</p><strong>{parsedRate}</strong><small>事件数 / 公告数</small></div></div>
        {eventCount === 0 && rawCount > 0 && <div className="dataNotice"><b>真实数据不为空：</b>已抓取 {rawCount} 条官方公告，其中 {pendingCount} 条等待 PDF 归档和字段解析。系统不会用不完整字段伪造质押事件。</div>}
        {view === "reviews" ? <ReviewPanel reviews={reviews} onOpen={openReview} /> : view === "logs" ? <LogsPanel runs={syncRuns} /> : <section className="panel">
          <div className="panelHead"><div><h2>{view === "announcements" ? "官方公告明细" : "质押事件明细"}</h2><span>{view === "announcements" ? "原始披露层 · 可追溯到官方 PDF" : "结构化事件层 · 已通过字段校验"}</span></div><div className="viewBtns"><button className={view === "announcements" ? "chosen" : ""} onClick={() => setView("announcements")}>原始公告</button><button className={view === "events" ? "chosen" : ""} onClick={() => setView("events")}>结构化事件</button></div></div>
          <div className="filters"><label><span>公告日期</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label className="wide"><span>股票 / 公告 / 相关方</span><input placeholder="输入关键词搜索" value={query} onChange={(e) => setQuery(e.target.value)} /></label><button className="searchBtn">查询</button><button className="reset" onClick={() => { setDate(""); setQuery(""); }}>重置</button></div>
          {view === "announcements" ? <><div className="resultMeta">共找到 <b>{filteredAnnouncements.length}</b> 条真实公告<span>来源：巨潮资讯官方披露</span></div><div className="tableWrap"><table className="announcementTable"><thead><tr><th>公告日期</th><th>股票</th><th>公告标题</th><th>状态</th><th>来源</th><th>哈希</th><th></th></tr></thead><tbody>{filteredAnnouncements.map((row) => <tr key={row.announcementId}><td className="mono">{row.announceDate}</td><td><b>{row.stockName}</b><small>{row.stockCode}</small></td><td title={row.title}>{row.title}</td><td><span className={`tag ${row.parseStatus === "parsed" ? "release" : row.parseStatus === "archived" ? "extra" : "new"}`}>{statusText[row.parseStatus] || row.parseStatus}</span></td><td><span className="sourceDot"></span>{row.source}</td><td className="mono">{row.sha256 ? `${row.sha256.slice(0, 10)}…` : "待归档"}</td><td><button className="detail" onClick={() => row.parseStatus === "queued" ? void archive(row) : window.open(row.pdfUrl, "_blank", "noopener,noreferrer")}>{row.parseStatus === "queued" ? "归档 PDF" : "查看原文"} ↗</button></td></tr>)}{!filteredAnnouncements.length && <tr><td colSpan={7} className="empty">该日期暂无已抓取公告；点击“同步公告”从巨潮资讯获取。</td></tr>}</tbody></table></div></> : <><div className="resultMeta">共找到 <b>{filteredEvents.length}</b> 条结构化事件<span>仅包含字段校验通过的数据</span></div><div className="tableWrap"><table><thead><tr><th>公告日期</th><th>股票</th><th>股东名称</th><th>质权人</th><th>质押数量</th><th>占其持股</th><th>占总股本</th><th>事件类型</th><th>来源</th></tr></thead><tbody>{filteredEvents.map((row) => <tr key={row.announcementId || row.id}><td>{row.date}</td><td><b>{row.name}</b><small>{row.code}</small></td><td>{row.shareholder}</td><td>{row.pledgee}</td><td>{row.amount}</td><td>{row.ratio}</td><td>{row.total}</td><td><span className="tag new">{row.type}</span></td><td>{row.source}</td></tr>)}{!filteredEvents.length && <tr><td colSpan={9} className="empty">已有真实公告，但尚未产生字段完整的质押事件。请先在公告中心归档 PDF。</td></tr>}</tbody></table></div></>}
          <div className="pagination"><span>当前显示 {view === "announcements" ? filteredAnnouncements.length : filteredEvents.length} 条</span></div>
        </section>}
        <footer><span>数据仅供研究参考，不构成投资建议</span><span>公开披露 · 原文可溯 · D1 持久化</span></footer>
      </div>
    </section>
    {editingReview && <div className="overlay" onClick={() => setEditingReview(null)}><aside className="drawer reviewDrawer" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setEditingReview(null)}>×</button><p className="eyebrow">MANUAL REVIEW</p><h2>补全质押事件字段</h2><div className="reviewSource"><b>{editingReview.stockName} · {editingReview.stockCode}</b><span>{editingReview.title}</span><small>{editingReview.reason}</small></div><div className="reviewForm"><label><span>股东名称 *</span><input value={reviewForm.shareholder} onChange={(event) => setReviewForm({ ...reviewForm, shareholder: event.target.value })} /></label><label><span>质权人 *</span><input value={reviewForm.pledgee} onChange={(event) => setReviewForm({ ...reviewForm, pledgee: event.target.value })} /></label><label><span>质押数量（股）*</span><input type="number" min="0" value={reviewForm.amount} onChange={(event) => setReviewForm({ ...reviewForm, amount: event.target.value })} /></label><label><span>数量原文</span><input placeholder="例如：1,000万股" value={reviewForm.amountText} onChange={(event) => setReviewForm({ ...reviewForm, amountText: event.target.value })} /></label><div className="reviewGrid"><label><span>占其持股</span><input placeholder="12.53%" value={reviewForm.pledgeRatio} onChange={(event) => setReviewForm({ ...reviewForm, pledgeRatio: event.target.value })} /></label><label><span>占总股本</span><input placeholder="3.15%" value={reviewForm.totalRatio} onChange={(event) => setReviewForm({ ...reviewForm, totalRatio: event.target.value })} /></label></div><label><span>事件类型</span><select value={reviewForm.type} onChange={(event) => setReviewForm({ ...reviewForm, type: event.target.value })}><option>新增质押</option><option>补充质押</option><option>解除质押</option><option>解除后再质押</option></select></label></div><div className="reviewActions"><button className="secondary danger" onClick={() => void resolveReview("rejected")}>驳回，不入库</button><button className="primary" disabled={!reviewForm.shareholder.trim() || !reviewForm.pledgee.trim() || !Number(reviewForm.amount)} onClick={() => void resolveReview("approved")}>审核通过并入库</button></div></aside></div>}
    {notice && <div className="toast">✓ {notice}</div>}
  </main>;
}
