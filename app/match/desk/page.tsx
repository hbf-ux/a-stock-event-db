"use client";

import { useCallback, useEffect, useState } from "react";

type RequestRow = { id:number;role:string;organization:string;stockCode?:string;shareholder?:string;amountMin:number;amountMax:number;termMonths?:number;preference?:string;purpose?:string;status:string;createdAt:string;candidateCount:number;readyCount:number };
type MatchStage = "reviewing"|"contacted"|"due_diligence"|"negotiating"|"completed"|"declined";
type MatchRow = { id:number;score:number;reasons:string[];status:string;side:"capital"|"financing";ownStage:MatchStage;counterpartStage?:MatchStage|null;ownConsented:boolean;counterpartConsented:boolean;bothConsented:boolean;counterpart:{role:string;amountMin:number;amountMax:number;termMonths?:number;summary:string;riskContextAttached:boolean;preference?:string;purpose?:string};contact?:{organization:string;contactName:string;email:string;stockCode?:string;shareholder?:string}|null;updatedAt:string };
type Funnel = { requests:{total?:number;open?:number;closed?:number};funnel:{candidates?:number;connected?:number;contacted?:number;dueDiligence?:number;negotiating?:number;completed?:number;declined?:number} };

const amount=(value:number)=>`${Math.round(value/10000).toLocaleString("zh-CN")} 万元`;
const stageLabels:Record<MatchStage,string>={reviewing:"待联系",contacted:"已联系",due_diligence:"尽调中",negotiating:"谈判中",completed:"已完成",declined:"不再推进"};
const stages:MatchStage[]=["reviewing","contacted","due_diligence","negotiating","completed","declined"];

export default function MatchDeskPage(){
  const [requests,setRequests]=useState<RequestRow[]>([]);
  const [matches,setMatches]=useState<MatchRow[]>([]);
  const [funnel,setFunnel]=useState<Funnel>({requests:{},funnel:{}});
  const [loading,setLoading]=useState(true);
  const [unauthorized,setUnauthorized]=useState(false);
  const [error,setError]=useState("");
  const [acting,setActing]=useState<string|null>(null);

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [requestResponse,matchResponse,funnelResponse]=await Promise.all([
        fetch("/api/match-requests",{cache:"no-store"}),
        fetch("/api/matches",{cache:"no-store"}),
        fetch("/api/match-funnel",{cache:"no-store"}),
      ]);
      if(requestResponse.status===401||matchResponse.status===401||funnelResponse.status===401){setUnauthorized(true);return;}
      if(!requestResponse.ok||!matchResponse.ok||!funnelResponse.ok)throw new Error("撮合进度暂不可用");
      const requestPayload=await requestResponse.json() as {data:RequestRow[]};
      const matchPayload=await matchResponse.json() as {data:MatchRow[]};
      const funnelPayload=await funnelResponse.json() as {data:Funnel};
      setRequests(requestPayload.data||[]);setMatches(matchPayload.data||[]);setFunnel(funnelPayload.data||{requests:{},funnel:{}});
    }catch(reason){setError(reason instanceof Error?reason.message:"加载失败");}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();},[load]);

  const mutate=async(key:string,url:string,method:"POST"|"PATCH",body?:object)=>{
    setActing(key);setError("");
    try{
      const response=await fetch(url,{method,headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});
      const payload=await response.json() as {error?:string};
      if(!response.ok)throw new Error(payload.error||"操作失败");
      await load();
    }catch(reason){setError(reason instanceof Error?reason.message:"操作失败");}
    finally{setActing(null);}
  };

  const roleLabel=(role:string)=>role==="capital"?"资金需求书":role==="advisor"?"FA 融资项目":"股东融资需求";
  const metrics=[
    ["进行中需求",funnel.requests.open||0,"仍在匹配"],
    ["匹配候选",funnel.funnel.candidates||0,"金额与期限初筛"],
    ["双向确认",funnel.funnel.connected||0,"已开放联系方式"],
    ["尽调中",funnel.funnel.dueDiligence||0,"当前账户标记"],
    ["谈判中",funnel.funnel.negotiating||0,"当前账户标记"],
    ["已完成",funnel.funnel.completed||0,"双方各自确认"],
  ] as const;

  return <main className="publicIntelPage matchDeskPage">
    <header className="publicHeader"><a className="publicBrand" href="/"><span>H</span><b>HBF质押日报<small>每日关账报告与融资撮合</small></b></a><nav><a href="/">今日日报</a><a href="/match">提交新需求</a><button>我的撮合</button></nav></header>
    <div className="publicWrap">
      <div className="publicBreadcrumb"><a href="/">首页</a><span>/</span><a href="/match">撮合服务</a><span>/</span><b>我的撮合</b></div>
      <section className="deskHero"><div><p className="eyebrow">PRIVATE MATCHING DESK</p><h1>融资撮合工作台</h1><p>管理当前账户的需求、双向授权和项目推进阶段；双方确认前，对方身份与联系方式保持匿名。</p></div><div><span>活跃项目</span><strong>{funnel.requests.open||0}</strong><small>{matches.length} 个匹配候选</small></div></section>
      {unauthorized?<section className="deskSignIn"><h2>登录后查看撮合进度</h2><p>需求和匹配结果属于私密信息，需要使用提交需求时的账户登录。</p><a href="/signin-with-chatgpt?return_to=/match/desk">登录并继续</a></section>:loading?<div className="publicState">正在加载你的撮合进度…</div>:<>
        <section className="deskFunnel">{metrics.map(([label,value,note])=><div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</section>
        <section className="deskSection"><div className="deskSectionHead"><div><h2>我的需求</h2><p>已关闭需求不会继续生成或推进候选</p></div><a href="/match">+ 提交新需求</a></div><div className="deskRequests">{requests.map((row)=><article key={row.id} className={row.status==="closed"?"closed":""}><div><span>#{row.id}</span><b>{roleLabel(row.role)}</b><small>{new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}</small></div><div><span>主体</span><b>{row.organization}</b><small>{row.stockCode?`${row.stockCode} · ${row.shareholder}`:"机构资金偏好"}</small></div><div><span>金额范围</span><b>{amount(row.amountMin)}–{amount(row.amountMax)}</b><small>{row.termMonths||"—"} 个月</small></div><div><span>匹配进度</span><b>{row.candidateCount} 个候选</b><small>{row.readyCount} 个已双向确认</small></div><div className="deskRequestAction"><em>{row.status==="new"?"核验中":row.status==="closed"?"已关闭":row.status}</em>{row.status!=="closed"&&<button disabled={acting===`close-${row.id}`} onClick={()=>void mutate(`close-${row.id}`,`/api/match-requests/${row.id}`,"PATCH",{status:"closed"})}>关闭</button>}</div></article>)}{!requests.length&&<div className="deskEmpty"><b>还没有撮合需求</b><p>先提交资金偏好或股东融资需求，系统会自动寻找金额和期限匹配的候选。</p><a href="/match">提交第一条需求</a></div>}</div></section>
        <section className="deskSection"><div className="deskSectionHead"><div><h2>匹配与推进</h2><p>双向确认后更新真实业务阶段，为后续尽调和成交复盘保留记录</p></div><span>{matches.length} 个</span></div><div className="deskMatches">{matches.map((row)=><article key={row.id} className={row.bothConsented?"ready":""}><div className="deskMatchScore"><strong>{row.score}</strong><span>匹配度</span></div><div className="deskCounterparty"><span>{row.counterpart.role==="capital"?"匿名资金方":"匿名融资项目"}</span><h3>{row.counterpart.summary}</h3><p>{amount(row.counterpart.amountMin)}–{amount(row.counterpart.amountMax)} · {row.counterpart.termMonths||"期限开放"}{row.counterpart.termMonths?" 个月":""}</p><small>{row.counterpart.preference||row.counterpart.purpose||"业务偏好待人工确认"}</small>{row.counterpart.riskContextAttached&&<em>已附官方事件摘要</em>}</div><div className="deskReasons">{row.reasons.map((reason)=><span key={reason}>✓ {reason}</span>)}{row.bothConsented&&<div className="deskStage"><label>我的阶段<select value={row.ownStage} disabled={acting===`stage-${row.id}`||row.status==="closed"} onChange={(event)=>void mutate(`stage-${row.id}`,`/api/matches/${row.id}/stage`,"PATCH",{stage:event.target.value})}>{stages.map((stage)=><option value={stage} key={stage}>{stageLabels[stage]}</option>)}</select></label>{row.counterpartStage&&<small>对方阶段：{stageLabels[row.counterpartStage]}</small>}</div>}</div><div className="deskConsent">{row.bothConsented&&row.contact?<><b>双方已确认</b><span>{row.contact.organization}</span><span>{row.contact.contactName}</span><a href={`mailto:${row.contact.email}`}>{row.contact.email}</a>{row.contact.stockCode&&<small>{row.contact.stockCode} · {row.contact.shareholder}</small>}<em className="deskStageBadge">{stageLabels[row.ownStage]}</em></>:row.ownConsented?<><b>已确认意向</b><span>{row.counterpartConsented?"正在开放联系方式":"等待对方确认"}</span></>:<><b>匿名候选</b><span>确认后仍需等待对方同意</span><button disabled={acting===`consent-${row.id}`} onClick={()=>void mutate(`consent-${row.id}`,`/api/matches/${row.id}/consent`,"POST")}>{acting===`consent-${row.id}`?"确认中…":"我有兴趣，确认匹配"}</button></>}</div></article>)}{!matches.length&&<div className="deskEmpty"><b>暂无匹配候选</b><p>系统会在新的资金偏好或融资需求出现后自动计算；没有候选不代表需求已被拒绝。</p></div>}</div></section>
      </>}
      {error&&<div className="deskToast">{error}</div>}
      <section className="deskPrivacy"><b>双向授权规则</b><span>第一次确认只表达匹配兴趣，不公开身份；只有资方和融资方都确认后，系统才返回机构、联系人和邮箱。项目阶段只对相关双方可见。</span></section>
      <footer className="publicFooter"><span>匹配度与阶段仅用于业务协同，不代表资金承诺、融资获批或信用结论。</span><span>质押雷达 · 私密撮合工作台</span></footer>
    </div>
  </main>;
}
