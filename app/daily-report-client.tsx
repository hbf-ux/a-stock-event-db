"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "./daily-report-pipeline.css";

type EventRow = { id:number;announcementId:string;date:string;code:string;name:string;shareholder:string;pledgee:string;amount:string;pledgeDate:string };
type Snapshot = {
  date:string; status:"collecting"|"reviewing"|"ready_to_close"|"provisional"|"published"; ready:boolean;
  announcement:{total?:number;pending?:number}; event:{total?:number;companies?:number};
  reconciliation:{complete:boolean;successfulSources:number;requiredSources:number;unresolved:number};
  events:EventRow[]; methodology:string; generatedAt:string;
};

const statusMap:Record<Snapshot["status"],{label:string;note:string}>={
  collecting:{label:"采集中",note:"20:00 前持续纳入官方公告"}, reviewing:{label:"核验中",note:"官方公告正在逐条核验"},
  ready_to_close:{label:"待发布",note:"完整性条件已满足"}, provisional:{label:"预览版",note:"未决公告仍在后台补齐"},
  published:{label:"正式发布",note:"本期日报已完成关账"},
};
const number=(value?:number)=>Number(value||0).toLocaleString("zh-CN");
const safe=(value?:string)=>String(value||"—").replace(/\s+/g," ").trim()||"—";

function fitText(ctx:CanvasRenderingContext2D,value:string,maxWidth:number){
  const text=safe(value);if(ctx.measureText(text).width<=maxWidth)return text;
  let output=text;while(output.length>1&&ctx.measureText(`${output}…`).width>maxWidth)output=output.slice(0,-1);
  return `${output}…`;
}
function saveCanvas(canvas:HTMLCanvasElement,filename:string){
  canvas.toBlob((blob)=>{if(!blob)return;const href=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=href;anchor.download=filename;anchor.click();window.setTimeout(()=>URL.revokeObjectURL(href),1000);},"image/png");
}
function drawHeader(ctx:CanvasRenderingContext2D,report:Snapshot,width:number,page?:{current:number;total:number}){
  ctx.fillStyle="#071a34";ctx.fillRect(0,0,width,300);ctx.fillStyle="#1769e0";ctx.fillRect(0,0,18,300);
  ctx.fillStyle="#fff";ctx.fillRect(58,48,92,92);ctx.fillStyle="#071a34";ctx.font="900 34px Arial";ctx.textAlign="center";ctx.fillText("HBF",104,106);ctx.textAlign="left";
  ctx.fillStyle="#91baf7";ctx.font="700 22px Arial";ctx.fillText("HBF SHAREHOLDER FINANCE INTELLIGENCE",180,73);
  ctx.fillStyle="#fff";ctx.font='700 47px "Microsoft YaHei", sans-serif';ctx.fillText("A股新增质押日报",180,132);
  ctx.fillStyle="#aec3df";ctx.font='24px "Microsoft YaHei", sans-serif';ctx.fillText("每日一图 · 官方公告整理 · 三所交叉核验",180,177);
  ctx.fillStyle="#fff";ctx.font="700 48px Georgia, serif";ctx.fillText(report.date,58,250);
  ctx.textAlign="right";ctx.fillStyle="#aec3df";ctx.font='22px "Microsoft YaHei", sans-serif';ctx.fillText(page?`小红书 3:4｜${page.current}/${page.total}`:"公众号长图｜完整清单",width-58,238);ctx.textAlign="left";
}
function drawSummary(ctx:CanvasRenderingContext2D,report:Snapshot,rows:EventRow[],shareholders:number,pledgees:number,y:number,width:number){
  const items=[["新增质押",rows.length],["涉及公司",report.event.companies||0],["质押股东",shareholders],["质权人",pledgees]] as const;
  const gap=14,margin=48,card=(width-margin*2-gap*3)/4;
  items.forEach(([label,value],index)=>{const x=margin+index*(card+gap);ctx.fillStyle="#f2f6fc";ctx.fillRect(x,y,card,118);ctx.fillStyle="#66758a";ctx.font='20px "Microsoft YaHei", sans-serif';ctx.fillText(label,x+20,y+35);ctx.fillStyle="#071a34";ctx.font="700 39px Georgia, serif";ctx.fillText(number(Number(value)),x+20,y+87);});
}
function drawEventCard(ctx:CanvasRenderingContext2D,row:EventRow,index:number,y:number,width:number){
  const margin=48;ctx.fillStyle=index%2===0?"#f7f9fc":"#eef3fa";ctx.fillRect(margin,y,width-margin*2,142);ctx.fillStyle="#1769e0";ctx.fillRect(margin,y,7,142);
  ctx.fillStyle="#071a34";ctx.font='700 27px "Microsoft YaHei", sans-serif';ctx.fillText(fitText(ctx,row.name,210),margin+25,y+40);ctx.fillStyle="#738096";ctx.font="20px Arial";ctx.fillText(safe(row.code),margin+245,y+39);
  ctx.textAlign="right";ctx.fillStyle="#071a34";ctx.font='700 25px "Microsoft YaHei", sans-serif';ctx.fillText(fitText(ctx,row.amount,230),width-margin-22,y+40);ctx.textAlign="left";
  ctx.fillStyle="#7a8799";ctx.font='18px "Microsoft YaHei", sans-serif';ctx.fillText("质押股东",margin+25,y+82);ctx.fillStyle="#1c2e47";ctx.font='22px "Microsoft YaHei", sans-serif';ctx.fillText(fitText(ctx,row.shareholder,310),margin+122,y+82);
  ctx.fillStyle="#1769e0";ctx.font="700 22px Arial";ctx.fillText("→",margin+450,y+82);ctx.fillStyle="#7a8799";ctx.font='18px "Microsoft YaHei", sans-serif';ctx.fillText("质权人",margin+495,y+82);ctx.fillStyle="#1c2e47";ctx.font='22px "Microsoft YaHei", sans-serif';ctx.fillText(fitText(ctx,row.pledgee,width-760),margin+580,y+82);
  ctx.fillStyle="#7a8799";ctx.font='18px "Microsoft YaHei", sans-serif';ctx.fillText(`质押日期 ${safe(row.pledgeDate)}`,margin+25,y+119);
}
function drawFooter(ctx:CanvasRenderingContext2D,report:Snapshot,y:number,width:number){
  ctx.fillStyle="#071a34";ctx.fillRect(0,y,width,150);ctx.fillStyle="#fff";ctx.font='700 22px "Microsoft YaHei", sans-serif';ctx.fillText(`${statusMap[report.status].label}｜仅收录新增质押｜报告日期 ${report.date}`,48,y+48);
  ctx.fillStyle="#aebfd5";ctx.font='17px "Microsoft YaHei", sans-serif';ctx.fillText("数据源：交易所与上市公司官方公告｜本资料仅供信息参考，不构成投资或授信建议",48,y+88);
  ctx.textAlign="right";ctx.fillStyle="rgba(255,255,255,.14)";ctx.font="900 72px Arial";ctx.fillText("HBF",width-48,y+105);ctx.textAlign="left";
}

export default function DailyReportClient(){
  const [report,setReport]=useState<Snapshot|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError("");try{const response=await fetch("/api/daily-report",{cache:"no-store"});if(!response.ok)throw new Error("今日日报暂不可用");setReport(await response.json() as Snapshot);}catch(reason){setError(reason instanceof Error?reason.message:"今日日报暂不可用");}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  const rows=report?.events||[];const shareholderCount=useMemo(()=>new Set(rows.map(row=>row.shareholder).filter(Boolean)).size,[rows]);const pledgeeCount=useMemo(()=>new Set(rows.map(row=>row.pledgee).filter(Boolean)).size,[rows]);
  const downloadWeChat=()=>{if(!report||!rows.length)return;const width=1080,firstY=468,rowStep=154,footerY=firstY+rows.length*rowStep+28,height=Math.max(1440,footerY+150);const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");if(!ctx)return;ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);drawHeader(ctx,report,width);drawSummary(ctx,report,rows,shareholderCount,pledgeeCount,328,width);rows.forEach((row,index)=>drawEventCard(ctx,row,index,firstY+index*rowStep,width));drawFooter(ctx,report,height-150,width);saveCanvas(canvas,`HBF-A股新增质押日报-${report.date}-公众号长图.png`);};
  const downloadXhs=()=>{if(!report||!rows.length)return;const perPage=5,total=Math.ceil(rows.length/perPage);for(let page=0;page<total;page++){window.setTimeout(()=>{const pageRows=rows.slice(page*perPage,(page+1)*perPage);const canvas=document.createElement("canvas");canvas.width=1080;canvas.height=1440;const ctx=canvas.getContext("2d");if(!ctx)return;ctx.fillStyle="#fff";ctx.fillRect(0,0,1080,1440);drawHeader(ctx,report,1080,{current:page+1,total});drawSummary(ctx,report,rows,shareholderCount,pledgeeCount,328,1080);pageRows.forEach((row,index)=>drawEventCard(ctx,row,page*perPage+index,468+index*154,1080));drawFooter(ctx,report,1290,1080);saveCanvas(canvas,`HBF-A股新增质押日报-${report.date}-小红书-${String(page+1).padStart(2,"0")}.png`);},page*250);}};
  return <main className="dailyPage"><header className="dailyHeader"><a className="dailyBrand" href="/"><span>HBF</span><b>质押日报<small>SHAREHOLDER FINANCE INTELLIGENCE</small></b></a><nav><a className="active" href="/">今日日报</a><a href="/match">撮合服务</a><a href="/match/desk">我的撮合</a></nav><a className="dailyEn" href="/en">EN</a></header>
    <div className="dailyShell">{loading?<div className="dailyState">正在生成今日日报…</div>:error?<div className="dailyState error">{error}<button onClick={()=>void load()}>重试</button></div>:report&&<>
      <section className="dailyMasthead"><div><p className="eyebrow">ONE DAY · ONE VERIFIED IMAGE</p><h1>{report.date}<br/>新增质押日报</h1><p>不做实时消息流，不堆叠历史页面。每天完成官方公告核验后，只发布一份轻量、清晰、可直接传播的新增质押日报图。</p></div><aside><span className={`closingStatus ${report.status}`}>{statusMap[report.status].label}</span><b>{statusMap[report.status].note}</b><small>公告口径：当日 20:00 截止</small><small>数据范围：仅新增质押</small><small>品牌发布：HBF</small></aside></section>
      <section className="dailyMetrics"><div><span>新增质押</span><strong>{number(report.event.total)}</strong><small>仅保留新增质押</small></div><div><span>涉及公司</span><strong>{number(report.event.companies)}</strong><small>按股票代码去重</small></div><div><span>质押股东</span><strong>{number(shareholderCount)}</strong><small>按股东名称去重</small></div><div><span>三所对账</span><strong>{report.reconciliation.successfulSources}/{report.reconciliation.requiredSources}</strong><small>{report.reconciliation.unresolved} 条差异待解决</small></div></section>
      <div className="dailyGrid"><section className="dailyReportCard"><div className="dailyCardHead"><div><p className="eyebrow">HBF OFFICIAL DAILY IMAGE</p><h2>当日新增质押清单</h2><p>下载时由浏览器即时生成，不占用云端图片存储。</p></div><div className="dailyActions"><button aria-label="下载1080像素公众号长图" onClick={downloadWeChat} disabled={!rows.length}>下载公众号长图</button><button aria-label="下载1080乘1440小红书分页图" className="primary" onClick={downloadXhs} disabled={!rows.length}>下载小红书 3:4 图</button></div></div>
        <div className="dailyTrust"><span className={report.reconciliation.complete?"done":""}>三所公告对账</span><span className={!Number(report.announcement.pending)?"done":""}>公告完成分类</span><span className={report.ready?"done":""}>差异清零</span><b>{report.status==="published"?"HBF 正式发布版":report.status==="provisional"?`预览版 · ${number(report.announcement.pending)} 份待补齐`:"核验完成后正式发布"}</b></div>
        <div className="dailyTable"><table><thead><tr><th>股票名称</th><th>股票代码</th><th>质押股东</th><th>质权人</th><th>质押股票数量</th><th>质押日期</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.announcementId}-${row.id}`}><td><b>{row.name}</b></td><td>{row.code||"—"}</td><td>{row.shareholder||"—"}</td><td>{row.pledgee||"—"}</td><td><b>{row.amount||"—"}</b></td><td>{row.pledgeDate||"—"}</td></tr>)}{!rows.length&&<tr><td colSpan={6} className="dailyEmpty">今日暂无已核验新增质押，或仍在审核中。</td></tr>}</tbody></table></div>
        <div className="dailyFootnote"><b>口径说明</b><p>{report.methodology}。本页只提供当期日报，不提供往期浏览。</p></div></section>
        <aside className="dailyAside"><section><p className="eyebrow">HBF BUSINESS MATCH</p><h2>从日报线索到融资撮合</h2><p>资方提交资金偏好，股东或 FA 提交融资需求。HBF 在双方授权后进行人工核验与撮合。</p><a href="/match">提交撮合需求 →</a></section><section><h3>图片发布规格</h3><dl><div><dt>公众号长图</dt><dd>1080px</dd></div><div><dt>小红书比例</dt><dd>3:4</dd></div><div><dt>核心字段</dt><dd>6</dd></div><div><dt>品牌标识</dt><dd>HBF</dd></div></dl></section></aside>
      </div><footer className="dailyFooter"><span>HBF 质押日报 · 官方公开信息整理</span><span>每日一图 · 轻量发布 · 撮合双方授权</span></footer>
    </>}</div></main>;
}
