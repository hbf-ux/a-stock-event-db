"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type EventRow = { id?: string; announcementId?: string; date: string; code: string; name: string; shareholder: string; pledgee: string; amount: string; ratio: string; total: string; type: string; source: string; pdfUrl?: string };
type AnnouncementRow = { announcementId: string; stockCode: string; stockName: string; title: string; announceDate: string; pdfUrl?: string; source: string; md5: string; sha256?: string; parseStatus: string; parseAttempts?: number; lastError?: string };
type ReviewRow = { id: number; announcementId: string; reason: string; payload: string; status: string; stockCode: string; stockName: string; title: string; announceDate: string; pdfUrl?: string };
type ReviewForm = { shareholder: string; pledgee: string; amount: string; amountText: string; pledgeRatio: string; totalRatio: string; type: string };
type SyncRun = { id: number; source: string; startedAt: string; finishedAt?: string; status: string; announcementsFound: number; eventsCreated: number; failures: number; message?: string };
type StatsData = { daily: { date: string; announcements: number; parsed: number }[]; eventTypes: { name: string; value: number }[]; pledgees: { name: string; value: number; amount: number }[]; statuses: { name: string; value: number }[] };
type Health = { stats?: { announcements?: number; events?: number; pending_reviews?: number } };
type CoverageData = { announcements?: { total?: number; firstDate?: string; latestDate?: string; stockCount?: number }; events?: { total?: number; firstDate?: string; latestDate?: string; stockCount?: number }; listedStocks?: { total?: number }; pending?: { total?: number }; latestRun?: { finishedAt?: string; status?: string }; scope?: string };
type StockCoverage = { stockCode: string; stockName: string; announcements: number; firstDate?: string; latestDate?: string; parsedAnnouncements: number; events: number; eventFirstDate?: string; eventLatestDate?: string };
type ProfileData = { stock: string; summary?: { name?: string; events?: number; pledged_amount?: number; latest_date?: string } | null; types: { type: string; count: number }[]; shareholders: { shareholder: string; events: number; amount: number; latest_date: string }[]; history: { date: string; type: string; amount: string; ratio?: string; total?: string; shareholder: string; pledgee: string; announcementId: string }[] };
type ShareholderProfile = { stockCode: string; shareholder: string; identityType: string; isController: boolean; isControllingShareholder: boolean; holdingShares?: number | null; holdingRatio?: string | null; sourceTitle?: string | null; sourceUrl?: string | null; sourceDate?: string | null; confidence: number; updatedAt: string };

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

function PositioningStrip() {
  return <section className="positioningStrip"><div><p className="eyebrow">SHAREHOLDER FINANCE RISK</p><h2>股东融资风险，先看变化</h2><p>从官方质押公告出发，追踪融资行为、控制权线索和授信尽调风险。</p></div><div className="positioningPills"><span>质押行为</span><span>股东历史</span><span>授信线索</span></div></section>;
}

function ShareholderProfilePanel({ stock, profiles, onSaved }: { stock: string; profiles: ShareholderProfile[]; onSaved: (profile: ShareholderProfile) => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ shareholder: "", identityType: "股东", holdingShares: "", holdingRatio: "", sourceTitle: "", sourceUrl: "", sourceDate: "" });
  const save = async () => {
    if (!form.shareholder.trim()) return;
    const response = await fetch("/api/shareholder-profiles", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stockCode: stock, ...form, holdingShares: form.holdingShares ? Number(form.holdingShares) : null }) });
    const result = await response.json() as { data?: ShareholderProfile; error?: string };
    if (!response.ok || !result.data) { window.alert(result.error || "需要登录后保存股东资料"); return; }
    onSaved(result.data); setEditing(false); setForm({ shareholder: "", identityType: "股东", holdingShares: "", holdingRatio: "", sourceTitle: "", sourceUrl: "", sourceDate: "" });
  };
  return <section className="shareholderProfilePanel"><div className="shareholderProfileHead"><div><p className="eyebrow">SHAREHOLDER MASTER DATA</p><h3>股东基础资料</h3></div><button className="secondary" onClick={() => setEditing(!editing)}>{editing ? "取消" : "新增 / 更新"}</button></div>{profiles.length ? <div className="shareholderProfileRows">{profiles.map((row) => <div key={row.shareholder}><div><b>{row.shareholder}</b><small>{row.identityType} · {row.isController ? "实控人" : row.isControllingShareholder ? "控股股东" : "身份待确认"}</small></div><span>{row.holdingRatio || "持股比例待补充"}</span><em>{row.sourceTitle || "来源待补充"}</em></div>)}</div> : <p className="empty">暂无已录入的股东基础资料。可从年报、权益变动公告或其他官方披露补充。</p>}{editing && <div className="shareholderProfileForm"><label>股东名称<input value={form.shareholder} onChange={(e) => setForm({ ...form, shareholder: e.target.value })} /></label><label>身份类型<select value={form.identityType} onChange={(e) => setForm({ ...form, identityType: e.target.value })}><option>股东</option><option>控股股东</option><option>实际控制人</option><option>一致行动人</option><option>机构股东</option></select></label><div className="reviewGrid"><label>持股数量<input type="number" min="0" value={form.holdingShares} onChange={(e) => setForm({ ...form, holdingShares: e.target.value })} /></label><label>持股比例<input placeholder="例如 18.25%" value={form.holdingRatio} onChange={(e) => setForm({ ...form, holdingRatio: e.target.value })} /></label></div><label>来源标题<input value={form.sourceTitle} onChange={(e) => setForm({ ...form, sourceTitle: e.target.value })} /></label><label>来源链接<input value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} /></label><label>披露日期<input type="date" value={form.sourceDate} onChange={(e) => setForm({ ...form, sourceDate: e.target.value })} /></label><button className="primary full" disabled={!form.shareholder.trim()} onClick={() => void save()}>保存股东资料</button></div>}<p className="researchDisclaimer">资料仅接受有来源的人工维护，保存后记录操作者与更新时间；不会自动把身份标签推断为授信结论。</p></section>;
}

function RiskSummaryPanel({ history, profiles }: { history: ProfileData["history"]; profiles: ShareholderProfile[] }) {
  const supplemental = history.filter((row) => row.type.includes("补充")).length;
  const releases = history.filter((row) => row.type.includes("解除")).length;
  const highRatio = history.filter((row) => Number((row.ratio || row.total || "").replace(/[^0-9.]/g, "")) >= 50).length;
  const pledgees = new Set(history.map((row) => row.pledgee).filter(Boolean)).size;
  const completeness = profiles.length ? Math.round((profiles.filter((row) => row.sourceTitle && (row.holdingRatio || row.holdingShares)).length / profiles.length) * 100) : 0;
  const score = Math.min(100, supplemental * 18 + highRatio * 12 + Math.max(0, history.length - releases) * 2 + (profiles.length ? Math.max(0, 20 - completeness / 5) : 20));
  const scoreLabel = score >= 65 ? "重点核查" : score >= 35 ? "持续观察" : "常规跟进";
  const signals = [
    ["历史事件", `${history.length} 条`, "已解析公告"],
    ["补充质押", `${supplemental} 次`, supplemental ? "需要重点核查" : "暂无补充信号"],
    ["解除质押", `${releases} 次`, "仅代表公告行为"],
    ["高比例信号", `${highRatio} 条`, "比例达到 50% 以上"],
    ["质权人数量", `${pledgees} 家`, "历史公告去重"],
    ["资料完整度", `${completeness}%`, profiles.length ? "基础资料来源覆盖" : "尚未录入基础资料"],
  ];
  return <section className="riskSummaryPanel"><div className="riskSummaryHead"><div><p className="eyebrow">CREDIT RESEARCH SIGNALS</p><h3>授信风险摘要</h3></div><span className={`tag ${score >= 65 ? "new" : score >= 35 ? "extra" : "release"}`}>{scoreLabel}</span></div><div className="scoreCard"><strong>{score}</strong><span>/ 100</span><b>{scoreLabel}</b><small>基于已解析行为与资料完整度</small></div><div className="riskSummaryGrid">{signals.map(([label, value, note]) => <div key={label}><span>{label}</span><b className={label === "补充质押" && supplemental ? "riskValue" : label === "高比例信号" && highRatio ? "warnValue" : ""}>{value}</b><small>{note}</small></div>)}</div><p className="researchDisclaimer">评分用于尽调排序，不等同于违约、信用或授信结论；存量质押仍需结合持股基数、解除记录和最新披露逐笔核对。</p></section>;
}

function CoveragePanel({ history }: { history: ProfileData["history"] }) {
  const dates = history.map((row) => row.date).filter(Boolean).sort();
  const truncated = history.length >= 100;
  return <div className="coveragePanel"><b>历史覆盖范围</b><span>{dates.length ? `${dates[0]} 至 ${dates[dates.length - 1]}` : "暂无已解析历史"}</span><small>{truncated ? "当前展示最近 100 条，可能仍有更早记录未加载" : "当前公司画像未达到 100 条展示上限"}</small></div>;
}

function ControlRiskPanel() {
  const rows = [
    ["控股股东 / 实控人", "待补充", "需要股东基础资料或最新年报确认"],
    ["股东持股基数", "待补充", "没有持股基数，不能反推当前质押率"],
    ["当前存量质押", "待核验", "历史公告已覆盖，存量需结合解除/新增逐笔核对"],
    ["历史质押行为", "已覆盖", "按官方公告形成时间序列"],
    ["原始公告追溯", "已覆盖", "保留公告链接、编号与哈希"],
  ];
  return <section className="controlRiskPanel"><div className="controlRiskHead"><div><p className="eyebrow">CONTROL & COLLATERAL GAPS</p><h3>控制权与授信关键资料</h3></div><span className="tag extra">不做推测</span></div><div className="controlRiskRows">{rows.map(([label, status, note]) => <div key={label}><span>{label}</span><b className={status === "已覆盖" ? "safeValue" : status === "待核验" ? "warnValue" : "muted"}>{status}</b><small>{note}</small></div>)}</div><p className="researchDisclaimer">本区只展示数据边界。控股股东、实际控制人、持股基数及当前存量质押不会从单条质押公告中臆测，补齐后才能用于授信判断。</p></section>;
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

function RiskLeaderboardPanel({ events, onProfile }: { events: EventRow[]; onProfile: (stock: string) => void }) {
  const rows = new Map<string, { code: string; name: string; events: number; supplemental: number; high: number; releases: number; latest: string }>();
  for (const event of events) {
    const row = rows.get(event.code) || { code: event.code, name: event.name, events: 0, supplemental: 0, high: 0, releases: 0, latest: event.date };
    row.events += 1; row.supplemental += event.type.includes("补充") ? 1 : 0; row.releases += event.type.includes("解除") ? 1 : 0; row.high += Number((event.ratio || event.total || "").replace(/[^0-9.]/g, "")) >= 50 ? 1 : 0; row.latest = row.latest > event.date ? row.latest : event.date; rows.set(event.code, row);
  }
  const ranked = [...rows.values()].map((row) => ({ ...row, score: Math.min(100, row.supplemental * 18 + row.high * 12 + Math.max(0, row.events - row.releases) * 2 + 20) })).sort((a, b) => b.score - a.score || b.latest.localeCompare(a.latest)).slice(0, 12);
  const label = (score: number) => score >= 65 ? "重点核查" : score >= 35 ? "持续观察" : "常规跟进";
  return <section className="panel riskLeaderboard"><div className="panelHead"><div><h2>公司风险排行榜</h2><span>统一评分口径，优先筛选资方需要核查的公司</span></div><span className="tag extra">TOP {ranked.length}</span></div><div className="leaderboardRows">{ranked.map((row, index) => <div className="leaderboardRow" key={row.code}><b className="rankNo">{index + 1}</b><button className="stockLink" onClick={() => onProfile(row.code)}><b>{row.name}</b><small>{row.code}</small></button><span className={`leaderScore ${row.score >= 65 ? "riskValue" : row.score >= 35 ? "warnValue" : "safeValue"}`}>{row.score}<small>/100</small></span><em>{label(row.score)}</em><p>补充 {row.supplemental} · 高比例 {row.high} · 最新 {row.latest}</p></div>)}{!ranked.length && <div className="empty">暂无足够的结构化事件用于排名</div>}</div><p className="researchDisclaimer">排行榜仅用于尽调排序；评分基于已解析公告行为，不代表违约、信用或授信结论。</p></section>;
}

function ResearchPanel({ events, onProfile }: { events: EventRow[]; onProfile: (stock: string) => void }) {
  const companyMap = new Map<string, { code: string; name: string; events: number; score: number; amount: number; latest: string }>();
  const relationMap = new Map<string, { shareholder: string; pledgee: string; companies: Set<string>; events: number; amount: number }>();
  const shareholderMap = new Map<string, { shareholder: string; companies: Set<string>; events: number; score: number; amount: number; latest: string }>();
  for (const row of events) {
    const score = Math.max(Number((row.ratio || "").replace(/[^0-9.]/g, "")) || 0, Number((row.total || "").replace(/[^0-9.]/g, "")) || 0);
    const company = companyMap.get(row.code) || { code: row.code, name: row.name, events: 0, score: 0, amount: 0, latest: row.date };
    company.events += 1; company.score = Math.max(company.score, score); company.amount += Number((row.amount || "").replace(/[^0-9.]/g, "")) || 0; company.latest = company.latest > row.date ? company.latest : row.date; companyMap.set(row.code, company);
    const key = `${row.shareholder}||${row.pledgee}`;
    const relation = relationMap.get(key) || { shareholder: row.shareholder, pledgee: row.pledgee, companies: new Set<string>(), events: 0, amount: 0 };
    relation.companies.add(row.code); relation.events += 1; relation.amount += Number((row.amount || "").replace(/[^0-9.]/g, "")) || 0; relationMap.set(key, relation);
    const shareholder = shareholderMap.get(row.shareholder) || { shareholder: row.shareholder, companies: new Set<string>(), events: 0, score: 0, amount: 0, latest: row.date };
    shareholder.companies.add(row.code); shareholder.events += 1; shareholder.score = Math.max(shareholder.score, score); shareholder.amount += Number((row.amount || "").replace(/[^0-9.]/g, "")) || 0; shareholder.latest = shareholder.latest > row.date ? shareholder.latest : row.date; shareholderMap.set(row.shareholder, shareholder);
  }
  const companies = [...companyMap.values()].sort((a, b) => b.score - a.score || b.events - a.events).slice(0, 10);
  const relations = [...relationMap.values()].sort((a, b) => b.companies.size - a.companies.size || b.events - a.events).slice(0, 8);
  const shareholders = [...shareholderMap.values()].sort((a, b) => b.score - a.score || b.events - a.events).slice(0, 8);
  return <section className="researchPanel"><div className="researchIntro"><div><p className="eyebrow">FA / CAPITAL RESEARCH</p><h2>质押研究摘要</h2><p>用风险排行和关系网络，快速找到需要进一步尽调的公司、股东与质权人。</p></div><span className="tag release">{events.length} 条已核验事件</span></div><div className="researchGrid"><section className="panel researchCard"><div className="panelHead"><div><h2>公司风险排行榜</h2><span>按质押比例信号和事件活跃度排序</span></div></div><div className="researchRows">{companies.map((row, index) => <div className="researchRow" key={row.code}><b className="rankNo">{index + 1}</b><button className="stockLink" onClick={() => onProfile(row.code)}><b>{row.name}</b><small>{row.code}</small></button><span className={row.score >= 50 ? "riskValue" : row.score >= 30 ? "warnValue" : ""}>{row.score ? `${row.score.toFixed(1)}%` : "待补充"}</span><em>{row.events} 条事件</em></div>)}{!companies.length && <div className="empty">暂无结构化事件</div>}</div></section><section className="panel researchCard"><div className="panelHead"><div><h2>股东—质权人关系</h2><span>识别重复出现的融资关系</span></div></div><div className="researchRows">{relations.map((row) => <div className="relationRow" key={`${row.shareholder}-${row.pledgee}`}><div><b>{row.shareholder}</b><small>→ {row.pledgee}</small></div><span>{row.companies.size} 家公司</span><em>{row.events} 次</em></div>)}{!relations.length && <div className="empty">暂无关系数据</div>}</div></section></div><p className="researchDisclaimer">研究摘要仅用于信息整理和尽调线索，不构成投资、融资或授信建议。</p></section>;
}

function ShareholderHistoryPanel({ events }: { events: EventRow[] }) {
  const rows = new Map<string, { name: string; companies: Set<string>; events: number; amount: number; maxRatio: number; latest: string }>();
  for (const event of events) {
    const current = rows.get(event.shareholder) || { name: event.shareholder, companies: new Set<string>(), events: 0, amount: 0, maxRatio: 0, latest: event.date };
    current.companies.add(event.code); current.events += 1; current.amount += Number((event.amount || "").replace(/[^0-9.]/g, "")) || 0; current.maxRatio = Math.max(current.maxRatio, Number((event.ratio || event.total || "").replace(/[^0-9.]/g, "")) || 0); current.latest = current.latest > event.date ? current.latest : event.date; rows.set(event.shareholder, current);
  }
  const items = [...rows.values()].sort((a, b) => b.maxRatio - a.maxRatio || b.events - a.events).slice(0, 10);
  return <section className="panel shareholderHistory"><div className="panelHead"><div><h2>股东历史质押画像</h2><span>按股东聚合历史事件，观察持续融资和集中质押信号</span></div><span className="tag extra">历史序列</span></div><div className="tableWrap"><table><thead><tr><th>股东</th><th>涉及公司</th><th>历史事件</th><th>累计数量</th><th>最高比例</th><th>最近日期</th></tr></thead><tbody>{items.map((item) => <tr key={item.name}><td><b>{item.name}</b></td><td>{item.companies.size} 家</td><td>{item.events} 次</td><td className="mono">{item.amount ? item.amount.toLocaleString("zh-CN") : "待核验"}</td><td className={item.maxRatio >= 50 ? "riskValue" : item.maxRatio >= 30 ? "warnValue" : ""}>{item.maxRatio ? `${item.maxRatio.toFixed(1)}%` : "待核验"}</td><td className="mono">{item.latest}</td></tr>)}{!items.length && <tr><td colSpan={6} className="empty">暂无股东历史质押数据</td></tr>}</tbody></table></div><p className="researchDisclaimer">累计数量按已解析公告求和；解除质押事件仍保留在历史序列中，不能直接等同于当前存量质押。</p></section>;
}

function ShareholderRiskPanel({ events }: { events: EventRow[] }) {
  const rows = new Map<string, { name: string; events: number; supplemental: number; releases: number; companies: Set<string>; pledgees: Set<string>; maxRatio: number; latest: string }>();
  for (const event of events) {
    const current = rows.get(event.shareholder) || { name: event.shareholder, events: 0, supplemental: 0, releases: 0, companies: new Set<string>(), pledgees: new Set<string>(), maxRatio: 0, latest: event.date };
    current.events += 1; current.supplemental += /补充/.test(event.type) ? 1 : 0; current.releases += /解除/.test(event.type) ? 1 : 0; current.companies.add(event.code); current.pledgees.add(event.pledgee); current.maxRatio = Math.max(current.maxRatio, Number((event.ratio || event.total || "").replace(/[^0-9.]/g, "")) || 0); current.latest = current.latest > event.date ? current.latest : event.date; rows.set(event.shareholder, current);
  }
  const items = [...rows.values()].sort((a, b) => (b.supplemental * 3 + b.maxRatio) - (a.supplemental * 3 + a.maxRatio)).slice(0, 6);
  const signal = (item: typeof items[number]) => item.maxRatio >= 50 || item.supplemental > 0 ? "重点核查" : item.events >= 3 || item.companies.size > 1 ? "持续融资" : "常规观察";
  return <section className="panel shareholderRisk"><div className="panelHead"><div><h2>资方风控信号</h2><span>从历史质押行为识别持续融资、补充质押和关系集中度</span></div><span className="tag extra">不含实控人判断</span></div><div className="riskSignalGrid">{items.map((item) => <article key={item.name}><div className="riskSignalTop"><b>{item.name}</b><span className={signal(item) === "重点核查" ? "riskValue" : signal(item) === "持续融资" ? "warnValue" : "safeValue"}>{signal(item)}</span></div><p>{item.events} 次事件 · {item.companies.size} 家公司 · {item.pledgees.size} 个质权人</p><small>补充 {item.supplemental} 次 / 解除 {item.releases} 次 · 最高比例 {item.maxRatio ? `${item.maxRatio.toFixed(1)}%` : "待核验"}</small><em>最近 {item.latest}</em></article>)}{!items.length && <div className="empty">暂无足够历史事件形成风控信号</div>}</div><p className="researchDisclaimer">“重点核查”是基于历史行为的筛选提示，不等同于违约或信用结论；实控人、控股股东身份需接入股东基础资料后再判断。</p></section>;
}

function WatchlistPanel({ events, watchlist, onProfile, onToggleWatch }: { events: EventRow[]; watchlist: string[]; onProfile: (stock: string) => void; onToggleWatch: (stock: string) => void }) {
  const rows = events.filter((row) => watchlist.includes(row.code)).slice(0, 100);
  return <section className="panel watchlistPanel"><div className="panelHead"><div><h2>我的关注</h2><span>关注公司的最新质押变化</span></div><span className="tag extra">{watchlist.length} 家公司</span></div>{watchlist.length === 0 ? <div className="watchEmpty"><strong>还没有关注股票</strong><p>在质押雷达中点击“关注”，这里会持续汇总最新变化。</p></div> : <div className="watchGrid">{watchlist.map((stock) => { const latest = rows.find((row) => row.code === stock); return <article className="watchCard" key={stock}><div className="watchCardTop"><button className="stockLink" onClick={() => onProfile(stock)}><b>{latest?.name || stock}</b><small>{stock}</small></button><button className="watchButton watched" onClick={() => onToggleWatch(stock)}>★</button></div>{latest ? <><p>{latest.shareholder} · {latest.type}</p><strong>{latest.amount}</strong><small>{latest.date} · {latest.ratio || "比例待核验"}</small></> : <p>暂无近期结构化事件</p>}</article>; })}</div>}</section>;
}

function AlertsPanel({ feedEvents, watchlist, onProfile }: { feedEvents: EventRow[]; watchlist: string[]; onProfile: (stock: string) => void }) {
  const alerts = feedEvents.filter((row) => watchlist.includes(row.code));
  return <section className="panel alertsPanel"><div className="panelHead"><div><h2>提醒中心</h2><span>关注股票在最近24小时的质押变化</span></div><span className="tag extra">{alerts.length} 条新提醒</span></div>{alerts.length ? <div className="alertList">{alerts.map((row) => <article key={`${row.announcementId}-${row.id}`} className="alertRow"><span className="alertDot"></span><div><button className="stockLink" onClick={() => onProfile(row.code)}><b>{row.name} · {row.code}</b></button><p>{row.shareholder} {row.type}，数量 {row.amount}</p><small>{row.date} · {row.source}</small></div><span className="tag new">查看画像</span></article>)}</div> : <div className="watchEmpty"><strong>暂无新提醒</strong><p>关注股票出现新的质押、解除或补充质押公告后，会出现在这里。</p></div>}</section>;
}

function StockCoveragePanel() {
  const [rows, setRows] = useState<StockCoverage[]>([]);
  useEffect(() => { void fetch("/api/stock-coverage", { cache: "no-store" }).then(async (response) => { if (!response.ok) return; const payload = await response.json() as { data?: StockCoverage[] }; setRows(payload.data || []); }); }, []);
  return <section className="stockCoverage panel"><div className="panelHead"><div><h2>公司级历史覆盖</h2><span>优先发现公告少、历史短或解析不足的股票</span></div><span className="tag extra">按覆盖薄弱排序</span></div><div className="tableWrap"><table><thead><tr><th>股票</th><th>公告范围</th><th>公告数</th><th>已解析</th><th>事件范围</th><th>事件数</th></tr></thead><tbody>{rows.map((row) => <tr key={row.stockCode}><td><b>{row.stockName}</b><small>{row.stockCode}</small></td><td className="mono">{row.firstDate || "—"} 至 {row.latestDate || "—"}</td><td className="mono">{row.announcements}</td><td className={row.parsedAnnouncements < row.announcements ? "warnValue mono" : "safeValue mono"}>{row.parsedAnnouncements}/{row.announcements}</td><td className="mono">{row.eventFirstDate || "—"} 至 {row.eventLatestDate || "—"}</td><td className="mono">{row.events}</td></tr>)}{!rows.length && <tr><td colSpan={6} className="empty">正在加载公司覆盖数据</td></tr>}</tbody></table></div><p className="researchDisclaimer">公告少不代表公司没有质押；可能是历史尚未回补、公告来源缺失或仍在待解析队列。</p></section>;
}

function BackfillPlanPanel() {
  const today = new Date().toISOString().slice(0,10);
  const [start, setStart] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0,10));
  const [end, setEnd] = useState(today);
  const [result, setResult] = useState<{missingDates?:string[];calendar?:{date:string;announcements:number}[];scope?:string} | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const inspect = async () => { setLoading(true); try { const response = await fetch(`/api/backfill-plan?start=${start}&end=${end}`, { cache: "no-store" }); const payload = await response.json() as { missingDates?: string[]; calendar?: {date:string;announcements:number}[]; scope?: string; error?: string }; if (!response.ok) throw new Error(payload.error || "回补计划检查失败"); setResult(payload); } catch (error) { window.alert(error instanceof Error ? error.message : "回补计划检查失败"); } finally { setLoading(false); } };
  const execute = async () => { setExecuting(true); try { const response = await fetch("/api/backfill-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start, end }) }); const payload = await response.json() as { inserted?: number; found?: number; failures?: number; error?: string }; if (!response.ok) throw new Error(payload.error || "缺口回补失败"); window.alert(`回补完成：发现 ${payload.found || 0} 条，新增 ${payload.inserted || 0} 条，失败 ${payload.failures || 0} 个日期`); await inspect(); } catch (error) { window.alert(error instanceof Error ? error.message : "缺口回补失败"); } finally { setExecuting(false); } };
  return <section className="backfillPlan panel"><div className="panelHead"><div><h2>历史回补计划</h2><span>先识别公告日期缺口，再决定是否回补</span></div><span className="tag extra">最多 31 天</span></div><div className="backfillControls"><label>开始日期<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>结束日期<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label><button className="secondary" disabled={loading || executing} onClick={() => void inspect()}>{loading ? "检查中…" : "检查缺口"}</button>{result?.missingDates?.length ? <button className="primary" disabled={executing} onClick={() => void execute()}>{executing ? "回补中…" : `执行 ${result.missingDates.length} 个缺口`}</button> : null}</div>{result && <div className="backfillResult"><b>{result.missingDates?.length || 0} 个日期没有已入库公告</b><div className="backfillDates">{(result.missingDates || []).map((date) => <span key={date}>{date}</span>)}</div><small>{result.scope}</small></div>}</section>;
}

function CoverageOverview({ coverage }: { coverage: CoverageData }) {
  const announcements = coverage.announcements || {};
  const events = coverage.events || {};
  return <section className="coverageOverview panel"><div className="panelHead"><div><h2>数据覆盖与完整性</h2><span>实时统计已抓取范围，不代表全市场全历史覆盖</span></div><span className="tag extra">官方公告范围</span></div><div className="coverageOverviewGrid"><div><span>公告起止日期</span><b>{announcements.firstDate || "—"} <i>至</i> {announcements.latestDate || "—"}</b><small>{announcements.total || 0} 条公告</small></div><div><span>结构化事件起止日期</span><b>{events.firstDate || "—"} <i>至</i> {events.latestDate || "—"}</b><small>{events.total || 0} 条质押事件</small></div><div><span>已覆盖股票</span><b>{announcements.stockCount || 0}</b><small>公告中出现的股票数量</small></div><div><span>待解析公告</span><b className={(coverage.pending?.total || 0) > 0 ? "warnValue" : "safeValue"}>{coverage.pending?.total || 0}</b><small>未纳入正式事件</small></div></div><p className="researchDisclaimer">覆盖率只反映当前数据库已抓取与已解析范围；如需全历史结论，仍需按股票回补公告并核对缺失日期。</p></section>;
}

function DashboardPanel({ stats, runs }: { stats: StatsData; runs: SyncRun[] }) {
  const maxDaily = Math.max(...stats.daily.map((row) => row.announcements),1);
  const maxPledgee = Math.max(...stats.pledgees.map((row) => row.value),1);
  return <div className="dashboardGrid"><section className="panel trendPanel"><div className="panelHead"><div><h2>近 14 日公告趋势</h2><span>官方公告数量与已解析数量</span></div></div><div className="barChart">{stats.daily.map((row) => <div className="barItem" key={row.date}><div className="barTrack"><i style={{ height:`${Math.max((row.announcements/maxDaily)*100,4)}%` }}></i><b style={{ height:`${Math.max((row.parsed/maxDaily)*100,0)}%` }}></b></div><strong>{row.announcements}</strong><span>{row.date.slice(5)}</span></div>)}{!stats.daily.length && <p className="chartEmpty">同步公告后显示趋势</p>}</div></section><section className="panel distributionPanel"><div className="panelHead"><div><h2>解析状态分布</h2><span>公告生产链路健康度</span></div></div><div className="statusList">{stats.statuses.map((row) => <div key={row.name}><span className={`statusDot ${row.name}`}></span><b>{statusText[row.name] || row.name}</b><strong>{row.value}</strong></div>)}{!stats.statuses.length && <p className="chartEmpty">暂无状态数据</p>}</div></section><section className="panel pledgeePanel"><div className="panelHead"><div><h2>主要质权人</h2><span>按结构化事件数量排名</span></div></div><div className="rankList">{stats.pledgees.map((row,index) => <div key={row.name}><em>{index+1}</em><span title={row.name}>{row.name}</span><i><b style={{width:`${(row.value/maxPledgee)*100}%`}}></b></i><strong>{row.value}</strong></div>)}{!stats.pledgees.length && <p className="chartEmpty">解析事件后显示排名</p>}</div></section><section className="panel recentPanel"><div className="panelHead"><div><h2>最近运行</h2><span>同步与解析任务</span></div></div><div className="recentRuns">{runs.slice(0,5).map((run) => <div key={run.id}><span className={`runState ${run.status}`}></span><p><b>{run.source === "pdf-parser" ? "PDF 解析" : "公告同步"}</b><small>{new Date(run.startedAt).toLocaleString("zh-CN",{hour12:false})}</small></p><strong>{run.status === "completed" ? "成功" : run.status === "failed" ? "失败" : "已完成"}</strong></div>)}{!runs.length && <p className="chartEmpty">暂无运行记录</p>}</div></section></div>;
}

export default function Home() {
  const [view, setView] = useState<"dashboard" | "watchlist" | "alerts" | "research" | "announcements" | "events" | "reviews" | "logs">("dashboard");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"all" | "high" | "watch" | "normal">("all");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [events, setEvents] = useState<EventRow[]>([]);
  const [feedEvents, setFeedEvents] = useState<EventRow[]>([]);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [shareholderProfiles, setShareholderProfiles] = useState<ShareholderProfile[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchlistSource, setWatchlistSource] = useState<"device" | "cloud">("device");
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [statsData, setStatsData] = useState<StatsData>({ daily:[],eventTypes:[],pledgees:[],statuses:[] });
  const [editingReview, setEditingReview] = useState<ReviewRow | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm>({ shareholder: "", pledgee: "", amount: "", amountText: "", pledgeRatio: "", totalRatio: "", type: "新增质押" });
  const [health, setHealth] = useState<Health>({});
  const [coverage, setCoverage] = useState<CoverageData>({});
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
      const [eventResponse, feedResponse, announcementResponse, healthResponse, reviewResponse, runResponse, statsResponse, coverageResponse] = await Promise.all([
        fetch("/api/events", { cache: "no-store" }),
        fetch("/api/feed?hours=24&limit=50", { cache: "no-store" }),
        fetch("/api/announcements", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/reviews", { cache: "no-store" }),
        fetch("/api/sync-runs", { cache: "no-store" }),
        fetch("/api/stats", { cache: "no-store" }),
        fetch("/api/coverage", { cache: "no-store" }),
      ]);
      if (!eventResponse.ok || !feedResponse.ok || !announcementResponse.ok || !healthResponse.ok || !reviewResponse.ok || !runResponse.ok || !statsResponse.ok || !coverageResponse.ok) throw new Error("API unavailable");
      const eventPayload = await eventResponse.json() as { data: EventRow[] };
      const announcementPayload = await announcementResponse.json() as { data: AnnouncementRow[] };
      setEvents(eventPayload.data);
      setFeedEvents((await feedResponse.json() as { data: EventRow[] }).data);
      setAnnouncements(announcementPayload.data);
      setReviews((await reviewResponse.json() as { data: ReviewRow[] }).data);
      setSyncRuns((await runResponse.json() as { data: SyncRun[] }).data);
      setStatsData(await statsResponse.json() as StatsData);
      setHealth(await healthResponse.json() as Health);
      setCoverage(await coverageResponse.json() as CoverageData);
      setState("online");
      if (!eventPayload.data.length && announcementPayload.data.length) setView("announcements");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => { void (async () => { try { const saved = window.localStorage.getItem("stock-event-watchlist"); if (saved) setWatchlist(JSON.parse(saved) as string[]); } catch {} try { const response = await fetch("/api/watchlist", { cache: "no-store" }); if (response.ok) { const payload = await response.json() as { data?: string[] }; setWatchlist(payload.data || []); setWatchlistSource("cloud"); } } catch {} })(); }, []);

  const filteredAnnouncements = useMemo(() => announcements.filter((row) => {
    const text = `${row.stockCode}${row.stockName}${row.title}`.toLowerCase();
    return (!date || row.announceDate === date) && (!query || text.includes(query.toLowerCase()));
  }), [announcements, date, query]);
  const filteredEvents = useMemo(() => events.filter((row) => {
    const text = `${row.code}${row.name}${row.shareholder}${row.pledgee}`.toLowerCase();
    const ratio = Number((row.ratio || "").replace(/[^0-9.]/g, ""));
    const total = Number((row.total || "").replace(/[^0-9.]/g, ""));
    const score = Math.max(ratio || 0, total || 0);
    const matchesRisk = riskFilter === "all" || (riskFilter === "high" && score >= 50) || (riskFilter === "watch" && score >= 30 && score < 50) || (riskFilter === "normal" && score < 30);
    return (!date || row.date === date) && (!query || text.includes(query.toLowerCase())) && matchesRisk;
  }), [events, date, query, riskFilter]);

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
  useEffect(() => { if (!profile) { setShareholderProfiles([]); return; } void fetch(`/api/shareholder-profiles?stock=${encodeURIComponent(profile.stock)}`, { cache: "no-store" }).then(async (response) => { if (!response.ok) return; const result = await response.json() as { data?: ShareholderProfile[] }; setShareholderProfiles(result.data || []); }); }, [profile]);
  const downloadResearchReport = (report: ProfileData) => {
    const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
    const rows = report.history.slice(0, 20).map((row) => `<tr><td>${escape(row.date)}</td><td>${escape(row.type)}</td><td>${escape(row.shareholder)}</td><td>${escape(row.pledgee)}</td><td>${escape(row.amount)}</td><td>${escape(row.ratio || row.total || "待核验")}</td></tr>`).join("");
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(report.summary?.name || report.stock)} 股东融资风控研究摘要</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#18202c;max-width:960px;margin:40px auto;line-height:1.6}h1{margin-bottom:4px}h2{border-bottom:1px solid #ddd;padding-bottom:8px;margin-top:30px}.meta{color:#65748a}.note{background:#f5f8fc;padding:14px;border-left:4px solid #1769e0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #e5e9ef;text-align:left}th{background:#f7f8fa}</style><h1>${escape(report.summary?.name || report.stock)}（${escape(report.stock)}）</h1><p class="meta">股东融资风控情报 · 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}</p><div class="note">质押事件：${report.summary?.events || 0} 次　最近日期：${escape(report.summary?.latest_date)}<br>控股股东/实控人身份、持股底数和当前存量质押：待补充基础资料。</div><h2>股东与质押轨迹</h2><table><thead><tr><th>日期</th><th>事件</th><th>股东</th><th>质权人</th><th>数量</th><th>比例</th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无已解析历史</td></tr>`}</tbody></table><h2>风控边界</h2><p>本摘要基于官方公开公告和已解析字段，仅用于尽调线索，不构成投资、融资、授信或法律意见。累计数量不等于当前存量质押。</p></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `${report.stock}-股东融资风控研究摘要.html`; link.click(); URL.revokeObjectURL(url); flash("研究摘要已下载");
  };
  const downloadScorecard = (report: ProfileData) => {
    const supplemental = report.history.filter((row) => row.type.includes("补充")).length;
    const releases = report.history.filter((row) => row.type.includes("解除")).length;
    const highRatio = report.history.filter((row) => Number((row.ratio || row.total || "").replace(/[^0-9.]/g, "")) >= 50).length;
    const score = Math.min(100, supplemental * 18 + highRatio * 12 + Math.max(0, report.history.length - releases) * 2 + (shareholderProfiles.length ? 10 : 20));
    const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
    const rows = report.history.slice(0, 50).map((row) => `<tr><td>${escape(row.date)}</td><td>${escape(row.type)}</td><td>${escape(row.shareholder)}</td><td>${escape(row.pledgee)}</td><td>${escape(row.amount)}</td><td>${escape(row.ratio || row.total)}</td></tr>`).join("");
    const profileRows = shareholderProfiles.map((row) => `<tr><td>${escape(row.shareholder)}</td><td>${escape(row.identityType)}</td><td>${escape(row.holdingRatio || row.holdingShares)}</td><td>${escape(row.sourceTitle)}</td><td>${escape(row.updatedAt)}</td></tr>`).join("");
    const html = `<!doctype html><meta charset="utf-8"><title>${escape(report.summary?.name || report.stock)} 风险评分卡</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#18202c;max-width:1000px;margin:36px auto;line-height:1.6}h1{margin-bottom:4px}h2{border-bottom:1px solid #ddd;padding-bottom:8px;margin-top:28px}.score{font-size:42px;color:#1769e0}.note{background:#f5f8fc;padding:14px;border-left:4px solid #1769e0}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:7px;border-bottom:1px solid #e5e9ef;text-align:left}th{background:#f7f8fa}</style><h1>${escape(report.summary?.name || report.stock)}（${escape(report.stock)}）</h1><p>股东融资风控情报 · 标准化风险评分卡 · ${new Date().toLocaleString("zh-CN", { hour12: false })}</p><div class="note"><span class="score">${score}</span> / 100<br>评分用于尽调排序，不等同于违约、信用或授信结论。历史事件 ${report.history.length} 条；补充质押 ${supplemental} 次；高比例信号 ${highRatio} 条。</div><h2>股东基础资料</h2><table><thead><tr><th>股东</th><th>身份</th><th>持股信息</th><th>来源</th><th>更新时间</th></tr></thead><tbody>${profileRows || `<tr><td colspan="5">暂无已录入的股东基础资料</td></tr>`}</tbody></table><h2>质押行为明细</h2><table><thead><tr><th>日期</th><th>类型</th><th>股东</th><th>质权人</th><th>数量</th><th>比例</th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无已解析历史</td></tr>`}</tbody></table><h2>数据边界</h2><p>本报告基于官方公告及已录入来源资料。持股基数、当前存量质押、控制权链条等未完整覆盖时，不做自动推断；正式授信前需人工核验原始披露。</p></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `${report.stock}-标准化风险评分卡.html`; link.click(); URL.revokeObjectURL(url); flash("标准化风险评分卡已下载");
  };
  const toggleWatch = async (stock: string) => { const adding = !watchlist.includes(stock); const next = adding ? [...watchlist, stock] : watchlist.filter((item) => item !== stock); setWatchlist(next); try { window.localStorage.setItem("stock-event-watchlist", JSON.stringify(next)); } catch {} if (watchlistSource === "cloud") { const response = await fetch("/api/watchlist", { method: adding ? "PUT" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ stock }) }); if (!response.ok) { setWatchlistSource("device"); flash("云端同步暂不可用，已保存在本设备"); return; } } flash(adding ? `已关注 ${stock}` : `已取消关注 ${stock}`); };
  const submitInterest = async () => { const response = await fetch("/api/subscribe-interest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: interestEmail, plan: "pro" }) }); const result = await response.json() as { ok?: boolean; error?: string; message?: string }; if (!response.ok) { flash(result.error || "提交失败"); return; } setInterestEmail(""); flash(result.message || "已登记"); };

  const rawCount = health.stats?.announcements ?? announcements.length;
  const eventCount = health.stats?.events ?? events.length;
  const pendingCount = health.stats?.pending_reviews ?? announcements.filter((row) => row.parseStatus !== "parsed").length;
  const parsedRate = rawCount ? `${((eventCount / rawCount) * 100).toFixed(1)}%` : "0.0%";
  const pageTitle = view === "dashboard" ? "质押雷达" : view === "watchlist" ? "我的关注" : view === "alerts" ? "提醒中心" : view === "research" ? "研究摘要" : view === "announcements" ? "公告中心" : view === "reviews" ? "人工审核" : view === "logs" ? "系统日志" : "股权质押";
  const pageDescription = view === "dashboard" ? "基于真实公告与结构化事件的运行概览。" : view === "announcements" ? "真实官方公告已入库；待解析公告保留在审核队列。" : view === "reviews" ? "补全自动解析缺失字段，审核操作全程留痕。" : view === "logs" ? "监控公告同步、PDF 解析与异常处理结果。" : "仅展示字段校验通过的结构化质押事件。";
  const pageEyebrow = view === "dashboard" ? "DATA OVERVIEW" : view === "announcements" ? "OFFICIAL ANNOUNCEMENTS" : view === "reviews" ? "REVIEW QUEUE" : view === "logs" ? "SYSTEM OPERATIONS" : "PLEDGE EVENTS";

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brandMark">融</div><div><strong>股东融资风控情报</strong><span>SHAREHOLDER FINANCE RISK</span></div></div>
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
        {view === "dashboard" ? <><RiskBrief events={events} feedEvents={feedEvents} announcements={announcements} runs={syncRuns} /><PositioningStrip /><RadarPanel events={events} feedEvents={feedEvents} announcements={announcements} stats={statsData} runs={syncRuns} onProfile={(stock) => void openProfile(stock)} watchlist={watchlist} onToggleWatch={toggleWatch} /><ResearchPanel events={events} onProfile={(stock) => void openProfile(stock)} /><ShareholderHistoryPanel events={events} /><ShareholderRiskPanel events={events} /></> : view === "watchlist" ? <WatchlistPanel events={events} watchlist={watchlist} onProfile={(stock) => void openProfile(stock)} onToggleWatch={toggleWatch} /> : view === "alerts" ? <AlertsPanel feedEvents={feedEvents} watchlist={watchlist} onProfile={(stock) => void openProfile(stock)} /> : view === "research" ? <><PositioningStrip /><ResearchPanel events={events} onProfile={(stock) => void openProfile(stock)} /><ShareholderHistoryPanel events={events} /><ShareholderRiskPanel events={events} /></> : view === "reviews" ? <ReviewPanel reviews={reviews} onOpen={openReview} onReprocess={() => void reprocessReviews()} reprocessing={reprocessing} /> : view === "logs" ? <LogsPanel runs={syncRuns} /> : <section className="panel">
          <div className="panelHead"><div><h2>{view === "announcements" ? "官方公告明细" : "质押事件明细"}</h2><span>{view === "announcements" ? "原始披露层 · 可追溯到官方 PDF" : "结构化事件层 · 已通过字段校验"}</span></div><div className="viewBtns"><button className={view === "announcements" ? "chosen" : ""} onClick={() => setView("announcements")}>原始公告</button><button className={view === "events" ? "chosen" : ""} onClick={() => setView("events")}>结构化事件</button></div></div>
          <div className="filters"><label><span>公告日期</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label className="wide"><span>股票 / 公告 / 相关方</span><input placeholder="输入关键词搜索" value={query} onChange={(e) => setQuery(e.target.value)} /></label>{view === "events" && <label><span>风险筛选</span><select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value as "all" | "high" | "watch" | "normal")}><option value="all">全部风险</option><option value="high">高关注 ≥ 50%</option><option value="watch">观察区 30%-50%</option><option value="normal">常规 &lt; 30%</option></select></label>}<button className="searchBtn">查询</button><button className="reset" onClick={() => { setDate(""); setQuery(""); setRiskFilter("all"); }}>重置</button></div>
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
    {view === "dashboard" && <><CoverageOverview coverage={coverage} /><BackfillPlanPanel /><StockCoveragePanel /></>}
    {(view === "dashboard" || view === "research") && <RiskLeaderboardPanel events={events} onProfile={(stock) => void openProfile(stock)} />}
    {profile && <CoveragePanel history={profile.history} />}
    {profile && <RiskSummaryPanel history={profile.history} profiles={shareholderProfiles} />}
    {profile && <ShareholderProfilePanel stock={profile.stock} profiles={shareholderProfiles} onSaved={(saved) => setShareholderProfiles((current) => [saved, ...current.filter((row) => row.shareholder !== saved.shareholder)])} />}
    {profile && <ControlRiskPanel />}
    {profile && <button className="floatingReport scorecardButton" onClick={() => downloadScorecard(profile)}>下载标准化评分卡</button>}
    {profile && <button className="floatingReport" onClick={() => downloadResearchReport(profile)}>下载资方研究摘要</button>}
  </main>;
}
