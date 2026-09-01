"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "./daily-report-pipeline.css";

type EventRow = { id:number;announcementId:string;date:string;code:string;name:string;shareholder:string;pledgee:string;amount:string;ratio:string;total:string;type:string;verificationStatus:string;pdfUrl?:string };
type Snapshot = {
  date:string; cutoffAt:string; status:"collecting"|"reviewing"|"ready_to_close"|"published"; ready:boolean;
  announcement:{total?:number;classified?:number;pending?:number}; event:{total?:number;companies?:number;releases?:number;supplemental?:number};
  verification:{humanVerified?:number;aiReviewed?:number;rulesValidated?:number};
  reconciliation:{complete:boolean;successfulSources:number;requiredSources:number;unresolved:number};
  automaticProduction?:{enabled:boolean;status:"disabled"|"fresh"|"running"|"started";targetDate:string;intervalMinutes:number;runId?:number;lastTriggeredAt?:string|null};
  published?:{reportVersion?:number;publishedAt?:string}|null; events:EventRow[]; methodology:string; generatedAt:string;
};

const statusMap:Record<Snapshot["status"],{label:string;note:string}>={
  collecting:{label:"采集中",note:"20:00 前持续纳入官方公告"},
  reviewing:{label:"审核中",note:"正在完成三所对账与逐条核验"},
  ready_to_close:{label:"待关账",note:"完整性条件已满足，等待正式发布"},
  published:{label:"已关账发布",note:"本报告已锁定版本，可正式使用"},
};
const number=(value?:number)=>Number(value||0).toLocaleString("zh-CN");

export default function DailyReportClient({requestedDate}:{requestedDate?:string}){
  const [report,setReport]=useState<Snapshot|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError("");try{const query=requestedDate?`?date=${encodeURIComponent(requestedDate)}`:"";const response=await fetch(`/api/daily-report${query}`,{cache:"no-store"});if(!response.ok)throw new Error("日报数据暂不可用");setReport(await response.json() as Snapshot);}catch(reason){setError(reason instanceof Error?reason.message:"日报数据暂不可用");}finally{setLoading(false);}},[requestedDate]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!report||report.status==="published")return;const timer=window.setInterval(()=>void load(),60_000);return()=>window.clearInterval(timer);},[load,report?.status]);
  const status=report?statusMap[report.status]:statusMap.collecting;
  const rows=report?.events||[];
  const highCount=useMemo(()=>rows.filter((row)=>Math.max(parseFloat(row.ratio)||0,parseFloat(row.total)||0)>=50).length,[rows]);

  const downloadImage=()=>{
    if(!report)return;
    const width=1500,rowHeight=108,top=450,footer=150,height=Math.max(920,top+rows.length*rowHeight+footer);
    const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");if(!ctx)return;
    ctx.fillStyle="#f4f0e8";ctx.fillRect(0,0,width,height);ctx.fillStyle="#0b1f3a";ctx.fillRect(0,0,width,250);
    ctx.fillStyle="#fff";ctx.font="700 32px sans-serif";ctx.fillText("HBF · A股质押日报",70,70);ctx.font="700 62px sans-serif";ctx.fillText(report.date,70,155);ctx.font="24px sans-serif";ctx.fillStyle="#b9c9e4";ctx.fillText("每日20:00关账｜官方公告三所交叉核验",70,205);
    const metrics=[["质押事件",number(report.event.total)],["涉及公司",number(report.event.companies)],["补充质押",number(report.event.supplemental)],["高比例信号",number(highCount)]];
    metrics.forEach(([label,value],index)=>{const x=70+index*350;ctx.fillStyle="#fff";ctx.fillRect(x,280,310,115);ctx.fillStyle="#65728a";ctx.font="22px sans-serif";ctx.fillText(label,x+24,320);ctx.fillStyle="#0b1f3a";ctx.font="700 42px sans-serif";ctx.fillText(value,x+24,375);});
    const columns=[70,220,445,700,990,1210];ctx.fillStyle="#0b1f3a";ctx.font="700 21px sans-serif";["股票","股东","质权人","股份数量","占个人持股","类型"].forEach((label,index)=>ctx.fillText(label,columns[index],435));
    rows.forEach((row,index)=>{const y=top+index*rowHeight;if(index%2===0){ctx.fillStyle="#ebe6dc";ctx.fillRect(50,y-10,width-100,rowHeight);}ctx.fillStyle="#12213a";ctx.font="700 22px sans-serif";ctx.fillText(`${row.name} ${row.code}`,columns[0],y+28);ctx.font="21px sans-serif";ctx.fillText((row.shareholder||"—").slice(0,16),columns[1],y+28);ctx.fillText((row.pledgee||"—").slice(0,20),columns[2],y+28);ctx.fillText(row.amount||"—",columns[3],y+28);ctx.fillText(row.ratio||"—",columns[4],y+28);ctx.fillText(row.type||"—",columns[5],y+28);ctx.fillStyle="#718096";ctx.font="17px sans-serif";ctx.fillText(`公告 ${row.announcementId||"—"} · ${row.verificationStatus||"已核验"}`,columns[0],y+66);});
    ctx.fillStyle="#0b1f3a";ctx.font="20px sans-serif";ctx.fillText(`关账状态：${status.label}｜事件 ${rows.length} 条｜生成自同一份关账数据`,70,height-72);ctx.textAlign="right";ctx.fillStyle="rgba(11,31,58,.22)";ctx.font="700 46px sans-serif";ctx.fillText("HBF",width-70,height-62);
    canvas.toBlob((blob)=>{if(!blob)return;const href=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=href;anchor.download=`HBF-A股质押日报-${report.date}.png`;anchor.click();URL.revokeObjectURL(href);},"image/png");
  };

  return <main className="dailyPage"><header className="dailyHeader"><a className="dailyBrand" href="/"><span>HBF</span><b>质押日报<small>股东融资情报与撮合</small></b></a><nav><a className={!requestedDate?"active":""} href="/">今日报告</a><a className={requestedDate?"active":""} href="/reports">历史日报</a><a href="/match">撮合服务</a><a href="/match/desk">我的撮合</a></nav><a className="dailyEn" href="/en">EN</a></header>
    <div className="dailyShell">{loading?<div className="dailyState">正在读取关账数据…</div>:error?<div className="dailyState error">{error}<button onClick={()=>void load()}>重试</button></div>:report&&<>
      <section className="dailyMasthead"><div><p className="eyebrow">DAILY PLEDGE CLOSING REPORT</p><h1>{report.date}<br/>A股质押日报</h1><p>只发布每日20:00前披露、完成三所交叉核验和逐条审核的正式清单。</p></div><aside><span className={`closingStatus ${report.status}`}>{status.label}</span><b>{status.note}</b><small>关账时间：{report.date} 20:00（北京时间）</small><small>{report.published?.reportVersion?`报告版本：V${report.published.reportVersion}`:"正式发布前数据可能更新"}</small></aside></section>
      {report.status!=="published"&&report.automaticProduction?.enabled&&<div className="dailyPipeline"><span className={report.automaticProduction.status==="running"||report.automaticProduction.status==="started"?"pulse":""}/><b>{report.automaticProduction.status==="running"||report.automaticProduction.status==="started"?"后台补跑中":"自动补跑已启用"}</b><em>目标交易日 {report.automaticProduction.targetDate}</em><small>{report.automaticProduction.runId?`任务 #${report.automaticProduction.runId}`:`每 ${report.automaticProduction.intervalMinutes} 分钟继续一批`} · 页面每分钟自动刷新</small></div>}
      <section className="dailyMetrics"><div><span>官方公告</span><strong>{number(report.announcement.total)}</strong><small>{number(report.announcement.pending)} 条待分类</small></div><div><span>质押事件</span><strong>{number(report.event.total)}</strong><small>逐条结构化核验</small></div><div><span>涉及公司</span><strong>{number(report.event.companies)}</strong><small>按股票代码去重</small></div><div><span>三所对账</span><strong>{report.reconciliation.successfulSources}/{report.reconciliation.requiredSources}</strong><small>{report.reconciliation.unresolved} 条差异待解决</small></div></section>
      <div className="dailyGrid"><section className="dailyReportCard"><div className="dailyCardHead"><div><p className="eyebrow">OFFICIAL DAILY LIST</p><h2>当日全部质押明细</h2><p>图片与PDF均由本页同一份关账数据生成。</p></div><div className="dailyActions"><button onClick={downloadImage} disabled={!rows.length}>下载长图 PNG</button><button className="primary" onClick={()=>window.print()} disabled={!rows.length}>打印 / 保存 PDF</button></div></div>
        <div className="dailyTrust"><span className={report.reconciliation.complete?"done":""}>三所公告对账</span><span className={!Number(report.announcement.pending)?"done":""}>公告完成分类</span><span className={report.ready?"done":""}>差异清零</span><b>{report.status==="published"?"正式关账版本":"未关账，不标注完整清单"}</b></div>
        <div className="dailyTable"><table><thead><tr><th>股票</th><th>质押股东</th><th>质权人</th><th>股份数量</th><th>占个人持股</th><th>事件</th><th>证据</th></tr></thead><tbody>{rows.map((row)=><tr key={`${row.announcementId}-${row.id}`}><td><a href={`/company/${row.code}`}><b>{row.name}</b><small>{row.code}</small></a></td><td>{row.shareholder||"—"}</td><td>{row.pledgee||"—"}</td><td><b>{row.amount||"—"}</b></td><td>{row.ratio||"—"}</td><td><span className={`dailyType ${row.type.includes("解除")?"release":row.type.includes("补充")?"extra":"new"}`}>{row.type}</span></td><td>{row.pdfUrl?<a href={row.pdfUrl} target="_blank" rel="noreferrer">官方原文 ↗</a>:"待归档"}</td></tr>)}{!rows.length&&<tr><td colSpan={7} className="dailyEmpty">该日期暂无已核验质押事件，或仍在关账审核中。</td></tr>}</tbody></table></div>
        <div className="dailyFootnote"><b>口径说明</b><p>{report.methodology}。质押公告是信息筛选线索，不构成授信或投资建议。</p></div></section>
        <aside className="dailyAside"><section><p className="eyebrow">BUSINESS MATCH</p><h2>有项目，才有数据价值</h2><p>资方提交资金偏好；股东或FA提交融资需求。平台基于官方质押历史先核验，再由人工完成双向授权撮合。</p><a href="/match">提交撮合需求 →</a></section><section><h3>今日核查信号</h3><dl><div><dt>补充质押</dt><dd>{number(report.event.supplemental)}</dd></div><div><dt>解除质押</dt><dd>{number(report.event.releases)}</dd></div><div><dt>高比例事件</dt><dd>{number(highCount)}</dd></div><div><dt>已核验事件</dt><dd>{number((report.verification.humanVerified||0)+(report.verification.aiReviewed||0)+(report.verification.rulesValidated||0))}</dd></div></dl></section><a className="archiveLink" href="/reports">查看历史关账日报 <span>→</span></a></aside>
      </div>
      <footer className="dailyFooter"><span>HBF 质押日报 · 官方公开信息整理</span><span>每日一关账 · 图片与PDF统一口径 · 撮合双方授权</span></footer>
    </>}</div></main>;
}
