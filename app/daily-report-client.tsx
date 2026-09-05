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
function loadQrImage(){
  return new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("二维码加载失败"));image.src="/hbf-wechat-qr.jpg";});
}
function drawHeader(ctx:CanvasRenderingContext2D,report:Snapshot,width:number,page?:{current:number;total:number}){
  ctx.fillStyle="#071a34";ctx.fillRect(0,0,width,210);ctx.fillStyle="#1769e0";ctx.fillRect(0,0,16,210);
  ctx.fillStyle="#fff";ctx.fillRect(48,36,70,70);ctx.fillStyle="#071a34";ctx.font="900 27px Arial";ctx.textAlign="center";ctx.fillText("HBF",83,81);ctx.textAlign="left";
  ctx.fillStyle="#91baf7";ctx.font="700 17px Arial";ctx.fillText("HBF SHAREHOLDER FINANCE INTELLIGENCE",145,55);
  ctx.fillStyle="#fff";ctx.font='700 39px "Microsoft YaHei", sans-serif';ctx.fillText("A股新增质押日报",145,101);
  ctx.fillStyle="#aec3df";ctx.font='19px "Microsoft YaHei", sans-serif';ctx.fillText("官方公告整理 · 三所交叉核验",145,136);
  ctx.fillStyle="#fff";ctx.font="700 38px Georgia, serif";ctx.fillText(report.date,48,183);
  ctx.textAlign="right";ctx.fillStyle="#aec3df";ctx.font='18px "Microsoft YaHei", sans-serif';ctx.fillText(page?`HBF 日报｜${page.current}/${page.total}`:"HBF 日报｜完整清单",width-48,178);ctx.textAlign="left";
}
function drawSummary(ctx:CanvasRenderingContext2D,report:Snapshot,rows:EventRow[],shareholders:number,pledgees:number,y:number,width:number){
  const items=[["新增质押",rows.length],["涉及公司",report.event.companies||0],["质押股东",shareholders],["质权人",pledgees]] as const;
  const gap=14,margin=48,card=(width-margin*2-gap*3)/4;
  items.forEach(([label,value],index)=>{const x=margin+index*(card+gap);ctx.fillStyle="#f2f6fc";ctx.fillRect(x,y,card,76);ctx.fillStyle="#66758a";ctx.font='16px "Microsoft YaHei", sans-serif';ctx.fillText(label,x+16,y+27);ctx.fillStyle="#071a34";ctx.font="700 28px Georgia, serif";ctx.fillText(number(Number(value)),x+16,y+61);});
}
function drawEventCard(ctx:CanvasRenderingContext2D,row:EventRow,index:number,x:number,y:number,width:number,height:number){
  const compact=height<66;ctx.fillStyle=index%2===0?"#f7f9fc":"#eef3fa";ctx.fillRect(x,y,width,height);ctx.fillStyle="#1769e0";ctx.fillRect(x,y,6,height);
  const left=x+18,right=x+width-16;ctx.fillStyle="#071a34";ctx.font=`700 ${compact?16:20}px "Microsoft YaHei", sans-serif`;ctx.fillText(fitText(ctx,row.name,width*.34),left,y+(compact?21:27));
  ctx.fillStyle="#738096";ctx.font=`${compact?13:15}px Arial`;ctx.fillText(safe(row.code),left+width*.35,y+(compact?21:27));
  ctx.textAlign="right";ctx.fillStyle="#071a34";ctx.font=`700 ${compact?15:18}px "Microsoft YaHei", sans-serif`;ctx.fillText(fitText(ctx,row.amount,width*.42),right,y+(compact?21:27));ctx.textAlign="left";
  ctx.fillStyle="#65758b";ctx.font=`${compact?12:14}px "Microsoft YaHei", sans-serif`;ctx.fillText(`股东 ${fitText(ctx,row.shareholder,width-(compact?118:92))}`,left,y+(compact?42:54));
  if(!compact){ctx.fillText(`质权人 ${fitText(ctx,row.pledgee,width-92)}`,left,y+78);ctx.textAlign="right";ctx.fillStyle="#8793a5";ctx.font='12px "Microsoft YaHei", sans-serif';ctx.fillText(safe(row.pledgeDate),right,y+78);ctx.textAlign="left";}
}
function drawFooter(ctx:CanvasRenderingContext2D,y:number,width:number,qr:HTMLImageElement){
  ctx.fillStyle="#071a34";ctx.fillRect(0,y,width,120);ctx.fillStyle="#d4e0ef";ctx.font='18px "Microsoft YaHei", sans-serif';ctx.fillText("数据来源：交易所与上市公司官方公告",48,y+68);
  const crop=Math.min(qr.naturalWidth*.68,qr.naturalHeight*.68),sx=qr.naturalWidth*.16,sy=qr.naturalHeight*.10,qrSize=94,cardX=width-154,cardY=y+8;
  ctx.fillStyle="#fff";ctx.fillRect(cardX,cardY,104,104);ctx.drawImage(qr,sx,sy,crop,crop,cardX+5,cardY+5,qrSize,qrSize);
}

export default function DailyReportClient(){
  const [report,setReport]=useState<Snapshot|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError("");try{const response=await fetch("/api/daily-report",{cache:"no-store"});if(!response.ok)throw new Error("今日日报暂不可用");setReport(await response.json() as Snapshot);}catch(reason){setError(reason instanceof Error?reason.message:"今日日报暂不可用");}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  const rows=report?.events||[];const shareholderCount=useMemo(()=>new Set(rows.map(row=>row.shareholder).filter(Boolean)).size,[rows]);const pledgeeCount=useMemo(()=>new Set(rows.map(row=>row.pledgee).filter(Boolean)).size,[rows]);
  const downloadDailyImage=async()=>{if(!report||!rows.length)return;try{const qr=await loadQrImage();const width=1080,height=1080,margin=48,gap=12,firstY=318,footerY=960;const columns=rows.length>14?3:2,gridRows=Math.ceil(rows.length/columns),cardWidth=(width-margin*2-gap*(columns-1))/columns,rowGap=8,cardHeight=Math.max(40,Math.min(94,(footerY-firstY-rowGap*Math.max(0,gridRows-1))/Math.max(1,gridRows)));const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");if(!ctx)return;ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);drawHeader(ctx,report,width);drawSummary(ctx,report,rows,shareholderCount,pledgeeCount,226,width);rows.forEach((row,index)=>{const column=index%columns,rowIndex=Math.floor(index/columns);drawEventCard(ctx,row,index,margin+column*(cardWidth+gap),firstY+rowIndex*(cardHeight+rowGap),cardWidth,cardHeight);});drawFooter(ctx,footerY,width,qr);saveCanvas(canvas,`HBF-A股新增质押日报-${report.date}.png`);}catch{setError("公众号二维码加载失败，请刷新页面后重试");}};
  return <main className="dailyPage"><header className="dailyHeader"><a className="dailyBrand" href="/"><span>HBF</span><b>质押日报<small>SHAREHOLDER FINANCE INTELLIGENCE</small></b></a><nav><a className="active" href="/">今日日报</a><a href="/match">撮合服务</a><a href="/match/desk">我的撮合</a></nav><a className="dailyEn" href="/en">EN</a></header>
    <div className="dailyShell">{loading?<div className="dailyState">正在生成今日日报…</div>:error?<div className="dailyState error">{error}<button onClick={()=>void load()}>重试</button></div>:report&&<>
      <section className="dailyMasthead"><div><p className="eyebrow">ONE DAY · ONE VERIFIED IMAGE</p><h1>{report.date}<br/>新增质押日报</h1><p>不做实时消息流，不堆叠历史页面。每天完成官方公告核验后，只发布一份轻量、清晰、可直接传播的新增质押日报图。</p></div><aside><span className={`closingStatus ${report.status}`}>{statusMap[report.status].label}</span><b>{statusMap[report.status].note}</b><small>公告口径：当日 20:00 截止</small><small>自动处理：20:30 截止，未完成转人工</small><small>数据范围：仅新增质押</small><small>品牌发布：HBF</small></aside></section>
      <section className="dailyMetrics"><div><span>新增质押</span><strong>{number(report.event.total)}</strong><small>仅保留新增质押</small></div><div><span>涉及公司</span><strong>{number(report.event.companies)}</strong><small>按股票代码去重</small></div><div><span>质押股东</span><strong>{number(shareholderCount)}</strong><small>按股东名称去重</small></div><div><span>三所对账</span><strong>{report.reconciliation.successfulSources}/{report.reconciliation.requiredSources}</strong><small>{report.reconciliation.unresolved} 条差异待解决</small></div></section>
      <div className="dailyGrid"><section className="dailyReportCard"><div className="dailyCardHead"><div><p className="eyebrow">HBF OFFICIAL DAILY IMAGE</p><h2>当日新增质押清单</h2><p>下载时由浏览器即时生成，不占用云端图片存储。</p></div><div className="dailyActions"><button aria-label="下载HBF新增质押日报图片" className="primary" onClick={downloadDailyImage} disabled={!rows.length}>下载日报图片</button></div></div>
        <div className="dailyTrust"><span className={report.reconciliation.complete?"done":""}>三所公告对账</span><span className={!Number(report.announcement.pending)?"done":""}>公告完成分类</span><span className={report.ready?"done":""}>差异清零</span><b>{report.status==="published"?"HBF 正式发布版":report.status==="provisional"?`预览版 · ${number(report.announcement.pending)} 份待补齐`:"核验完成后正式发布"}</b></div>
        <div className="dailyTable"><table><thead><tr><th>股票名称</th><th>股票代码</th><th>质押股东</th><th>质权人</th><th>质押股数（股）</th><th>质押日期</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.announcementId}-${row.id}`}><td><b>{row.name}</b></td><td>{row.code||"—"}</td><td>{row.shareholder||"—"}</td><td>{row.pledgee||"—"}</td><td><b>{row.amount||"—"}</b></td><td>{row.pledgeDate||"—"}</td></tr>)}{!rows.length&&<tr><td colSpan={6} className="dailyEmpty">今日暂无已核验新增质押，或仍在审核中。</td></tr>}</tbody></table></div>
        <div className="dailyFootnote"><b>口径说明</b><p>{report.methodology}。本页只提供当期日报，不提供往期浏览。</p></div></section>
        <aside className="dailyAside"><section><p className="eyebrow">HBF BUSINESS MATCH</p><h2>从日报线索到融资撮合</h2><p>资方提交资金偏好，股东或 FA 提交融资需求。HBF 在双方授权后进行人工核验与撮合。</p><a href="/match">提交撮合需求 →</a></section><section><h3>数据统计口径</h3><dl><div><dt>新增质押</dt><dd>事件行</dd></div><div><dt>涉及公司</dt><dd>代码去重</dd></div><div><dt>质押股东</dt><dd>名称去重</dd></div><div><dt>质权人</dt><dd>名称去重</dd></div></dl><p>只统计新增质押；解除质押、解除后再质押、补充质押及展期均不计入。</p></section></aside>
      </div><footer className="dailyFooter"><span>HBF 质押日报 · 官方公开信息整理</span><span>每日一图 · 轻量发布 · 撮合双方授权</span></footer>
    </>}</div></main>;
}
