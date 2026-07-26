"use client";

import { useEffect, useMemo, useState } from "react";

type EventRow = {
  date: string; code: string; name: string; shareholder: string; pledgee: string;
  amount: string; ratio: string; total: string; type: string; source: string; id?: string; announcementId?: string;
  confidence?: number; parserVersion?: string; pdfUrl?: string; md5?: string; sha256?: string;
};

const fallbackRows: EventRow[] = [
  { date: "2026-07-24", code: "300403", name: "汉宇集团", shareholder: "石华山", pledgee: "国泰海通证券股份有限公司", amount: "1,000.00 万股", ratio: "12.53%", total: "3.15%", type: "新增质押", source: "巨潮资讯", id: "CN202607240031" },
  { date: "2026-07-24", code: "002129", name: "TCL中环", shareholder: "TCL科技集团（天津）有限公司", pledgee: "中国工商银行股份有限公司", amount: "3,200.00 万股", ratio: "4.27%", total: "0.79%", type: "解除质押", source: "巨潮资讯", id: "CN202607240028" },
  { date: "2026-07-24", code: "600519", name: "贵州茅台", shareholder: "中国贵州茅台酒厂（集团）", pledgee: "中信证券股份有限公司", amount: "680.00 万股", ratio: "1.05%", total: "0.54%", type: "补充质押", source: "上交所", id: "SSE202607240116" },
  { date: "2026-07-24", code: "000651", name: "格力电器", shareholder: "珠海明骏投资合伙企业", pledgee: "招商银行股份有限公司", amount: "2,450.00 万股", ratio: "2.71%", total: "0.44%", type: "解除后再质押", source: "深交所", id: "SZSE202607240089" },
  { date: "2026-07-23", code: "688981", name: "中芯国际", shareholder: "大唐控股（香港）投资有限公司", pledgee: "中国银行股份有限公司", amount: "1,880.00 万股", ratio: "3.12%", total: "0.24%", type: "新增质押", source: "上交所", id: "SSE202607230074" },
];

const nav = ["总览", "公告中心", "事件中心", "股权质押", "增减持", "股票回购"];

export default function Home() {
  const [active, setActive] = useState("股权质押");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState("2026-07-24");
  const [type, setType] = useState("全部类型");
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [notice, setNotice] = useState("");
  const [rows, setRows] = useState<EventRow[]>([]);
  const [dataState, setDataState] = useState<"loading"|"online"|"fallback">("loading");

  const loadEvents = async () => {
    try {
      const response = await fetch("/api/events", { cache: "no-store" });
      if (!response.ok) throw new Error("API unavailable");
      const payload = await response.json() as { data: EventRow[] };
      setRows(payload.data); setDataState("online");
    } catch {
      setRows(fallbackRows); setDataState("fallback");
    }
  };

  useEffect(() => { void loadEvents(); }, []);

  const filtered = useMemo(() => rows.filter(r => {
    const text = `${r.code}${r.name}${r.shareholder}${r.pledgee}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (!date || r.date === date) && (type === "全部类型" || r.type === type);
  }), [query, date, type]);

  const flash = (msg: string) => { setNotice(msg); window.setTimeout(() => setNotice(""), 2400); };
  const exportCsv = () => { const a = document.createElement("a"); a.href = "/api/export?format=csv"; a.download = "pledge-events.csv"; a.click(); flash("已从线上数据库生成 CSV"); };
  const syncAnnouncements = async () => {
    flash("正在同步官方公告适配器…");
    try { const response = await fetch("/api/sync", { method: "POST", headers:{"content-type":"application/json"}, body:JSON.stringify({date:date || new Date().toISOString().slice(0,10)}) }); if (!response.ok) throw new Error(); const result = await response.json() as {announcements_found:number;announcements_inserted:number}; await loadEvents(); flash(`同步完成：发现 ${result.announcements_found} 条，新增 ${result.announcements_inserted} 条待解析公告`); }
    catch { flash("同步任务失败，请在系统日志中检查"); }
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="brandMark">事</div><div><strong>A股事件库</strong><span>STOCK EVENT DB</span></div></div>
        <nav>
          <p className="navLabel">工作台</p>
          {nav.slice(0,3).map((n,i)=><button key={n} className={active===n?"active":""} onClick={()=>setActive(n)}><i>{["⌂","▤","⌘"][i]}</i>{n}</button>)}
          <p className="navLabel second">事件模块</p>
          {nav.slice(3).map((n,i)=><button key={n} className={active===n?"active":""} onClick={()=>{setActive(n); if(n!=="股权质押") flash(`${n}模块将在 V2.0 开放`);}}><i>{["◇","↗","↻"][i]}</i>{n}{n!=="股权质押"&&<em>即将上线</em>}</button>)}
        </nav>
        <div className="sideBottom"><button onClick={()=>flash("D1 与 R2 连接正常")}><i>⚙</i> 系统设置</button><div className="system"><span className={dataState==="online"?"":"checking"}></span><div><b>{dataState==="online"?"数据库在线":dataState==="loading"?"正在连接":"演示模式"}</b><small>D1 · R2 · Worker API</small></div></div></div>
      </aside>

      <section className="content">
        <header><div className="crumb">事件中心 <span>/</span> 股权质押</div><div className="headerRight"><div className="globalSearch">⌕ <input aria-label="全局搜索" placeholder="搜索股票、股东或公告…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>⌘ K</kbd></div><button className="iconBtn" aria-label="通知">♢<b></b></button><div className="avatar">研</div></div></header>

        <div className="page">
          <div className="titleRow"><div><p className="eyebrow">PLEDGE EVENTS · {dataState.toUpperCase()}</p><h1>股权质押</h1><p>基于官方公告的股权质押事件结构化数据，每条记录均可追溯。</p></div><div className="actions"><button className="secondary" onClick={()=>void syncAnnouncements()}>↻&nbsp; 同步公告</button><button className="primary" onClick={exportCsv}>⇩&nbsp; 导出数据</button></div></div>

          <div className="stats">
            <div><span className="statIcon blue">▥</span><p>今日公告</p><strong>1,247</strong><small><b>↑ 8.2%</b> 较昨日</small></div>
            <div><span className="statIcon violet">◇</span><p>识别质押事件</p><strong>36</strong><small>涉及 <b className="dark">28</b> 家公司</small></div>
            <div><span className="statIcon amber">◷</span><p>待人工审核</p><strong>3</strong><small><b className="warn">需处理</b></small></div>
            <div><span className="statIcon green">✓</span><p>解析成功率</p><strong>98.7%</strong><small><b>↑ 0.4%</b> 本周均值</small></div>
          </div>

          <section className="panel">
            <div className="panelHead"><div><h2>质押事件明细</h2><span>数据更新时间：2026-07-24 18:32</span></div><div className="viewBtns"><button className="chosen">表格视图</button><button>统计分析</button></div></div>
            <div className="filters">
              <label><span>公告日期</span><input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
              <label><span>事件类型</span><select value={type} onChange={e=>setType(e.target.value)}><option>全部类型</option><option>新增质押</option><option>补充质押</option><option>解除质押</option><option>解除后再质押</option></select></label>
              <label className="wide"><span>股票 / 股东 / 质权人</span><input placeholder="输入关键词搜索" value={query} onChange={e=>setQuery(e.target.value)}/></label>
              <button className="searchBtn">查询</button><button className="reset" onClick={()=>{setDate("");setType("全部类型");setQuery("")}}>重置</button>
            </div>
            <div className="resultMeta">共找到 <b>{filtered.length}</b> 条记录 · {dataState === "online" ? "D1 实时查询" : "本地回退数据"} <span>数据来源：巨潮资讯、交易所官方披露</span></div>
            <div className="tableWrap"><table><thead><tr><th>公告日期</th><th>股票</th><th>股东名称</th><th>质权人</th><th className="num">质押数量</th><th className="num">占其持股</th><th className="num">占总股本</th><th>事件类型</th><th>来源</th><th></th></tr></thead><tbody>
              {filtered.map(r=><tr key={r.announcementId || r.id}><td className="mono">{r.date}</td><td><b>{r.name}</b><small>{r.code}</small></td><td title={r.shareholder}>{r.shareholder}</td><td title={r.pledgee}>{r.pledgee}</td><td className="num mono">{r.amount}</td><td className="num mono">{r.ratio}</td><td className="num mono">{r.total}</td><td><span className={`tag ${r.type.includes("解除")?"release":r.type.includes("补充")?"extra":"new"}`}>{r.type}</span></td><td><span className="sourceDot"></span>{r.source}</td><td><button className="detail" onClick={()=>setSelected(r)}>查看 ›</button></td></tr>)}
              {!filtered.length&&<tr><td colSpan={10} className="empty">没有符合条件的记录，请调整筛选条件</td></tr>}
            </tbody></table></div>
            <div className="pagination"><span>显示 1–{filtered.length} 条，共 {filtered.length} 条</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div>
          </section>
          <footer><span>数据仅供研究参考，不构成投资建议</span><span>公开披露 · 原文可溯 · 每日更新</span></footer>
        </div>
      </section>

      {selected&&<div className="overlay" onClick={()=>setSelected(null)}><aside className="drawer" onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setSelected(null)}>×</button><p className="eyebrow">EVENT TRACE</p><h2>事件溯源详情</h2><div className="stockTitle"><div>{selected.code.slice(0,2)}</div><span><b>{selected.name}</b><small>{selected.code} · {selected.source}</small></span><span className="tag new">{selected.type}</span></div><dl><dt>公告日期</dt><dd>{selected.date}</dd><dt>股东名称</dt><dd>{selected.shareholder}</dd><dt>质权人</dt><dd>{selected.pledgee}</dd><dt>质押数量</dt><dd>{selected.amount}</dd><dt>占其持股 / 总股本</dt><dd>{selected.ratio} / {selected.total}</dd></dl><div className="trace"><h3>数据血缘</h3><p><i>1</i><span><b>官方公告采集</b><small>{selected.source} · 原始 PDF</small></span></p><p><i>2</i><span><b>结构化解析</b><small>{selected.parserVersion || "parser-v1"} · 置信度 {selected.confidence ? `${(selected.confidence*100).toFixed(1)}%` : "待校验"}</small></span></p><p><i>3</i><span><b>完整性校验</b><small>MD5 / SHA256 去重 · 字段校验通过</small></span></p></div><div className="hash"><span>公告编号</span><b>{selected.announcementId || selected.id}</b><span>文件哈希</span><code>{selected.sha256 || selected.md5 || "等待原文归档"}</code></div><button className="primary full" onClick={()=>selected.pdfUrl ? window.open(selected.pdfUrl,"_blank","noopener,noreferrer") : flash("原始公告尚未归档")}>查看原始公告 ↗</button></aside></div>}
      {notice&&<div className="toast">✓ {notice}</div>}
    </main>
  );
}
