"use client";

import { useEffect, useState } from "react";

type ReportRow={date:string;announcements:number;events:number;companies:number;pending:number;status:string;ready:boolean;publishedAt?:string;reconciliation:{complete:boolean;successfulSources:number;requiredSources:number;unresolved:number}};
const labels:Record<string,string>={published:"已关账",ready_to_close:"待关账",reviewing:"审核中",collecting:"采集中"};

export default function ReportsPage(){
  const [rows,setRows]=useState<ReportRow[]>([]);const [loading,setLoading]=useState(true);
  useEffect(()=>{void fetch("/api/daily-reports",{cache:"no-store"}).then((response)=>response.json() as Promise<{data:ReportRow[]}>).then((payload)=>setRows(payload.data||[])).finally(()=>setLoading(false));},[]);
  return <main className="dailyPage"><header className="dailyHeader"><a className="dailyBrand" href="/"><span>HBF</span><b>质押日报<small>股东融资情报与撮合</small></b></a><nav><a href="/">今日报告</a><a className="active" href="/reports">历史日报</a><a href="/match">撮合服务</a><a href="/match/desk">我的撮合</a></nav><a className="dailyEn" href="/en">EN</a></header><div className="archiveShell"><div className="archiveIntro"><p className="eyebrow">DAILY REPORT ARCHIVE</p><h1>每日关账归档</h1><p>每个交易日只保留一份正式口径。未完成三所对账或差异未清零的日期，会明确标记为审核中。</p></div>{loading?<div className="dailyState">正在读取归档…</div>:<section className="archiveTable"><div className="archiveHead"><span>日期</span><span>关账状态</span><span>官方公告</span><span>质押事件</span><span>涉及公司</span><span>完整性</span><span></span></div>{rows.map((row)=><a href={`/report/${row.date}`} key={row.date}><b>{row.date}</b><span className={`closingStatus ${row.status}`}>{labels[row.status]||row.status}</span><span>{Number(row.announcements||0)}</span><span>{Number(row.events||0)}</span><span>{Number(row.companies||0)}</span><span>{row.reconciliation.complete&&Number(row.pending||0)===0?"三所对账完成":"仍在核验"}</span><em>查看 →</em></a>)}{!rows.length&&<div className="dailyEmpty">暂无可展示的日报日期。</div>}</section>}<div className="archiveCta"><div><h2>需要资金或项目？</h2><p>日报负责确认事实，撮合服务负责推动业务进入核验、尽调与双向授权对接。</p></div><a href="/match">进入撮合服务 →</a></div></div></main>;
}
