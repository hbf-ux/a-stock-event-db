import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { extractText, getDocumentProxy } from "unpdf";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers || {}) } });

async function ensureSchema(db: D1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS stock_info (code TEXT PRIMARY KEY, name TEXT NOT NULL, exchange TEXT NOT NULL, industry TEXT, list_date TEXT, status TEXT NOT NULL DEFAULT '上市')`,
    `CREATE TABLE IF NOT EXISTS announcement (announcement_id TEXT PRIMARY KEY, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, title TEXT NOT NULL, announce_date TEXT NOT NULL, pdf_url TEXT, r2_key TEXT, source TEXT NOT NULL, crawl_time TEXT NOT NULL, md5 TEXT NOT NULL UNIQUE, sha256 TEXT, parse_status TEXT NOT NULL DEFAULT 'pending')`,
    `CREATE TABLE IF NOT EXISTS pledge (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, shareholder TEXT NOT NULL, pledgee TEXT NOT NULL, pledge_amount REAL NOT NULL, pledge_amount_text TEXT NOT NULL, pledge_ratio TEXT, total_ratio TEXT, start_date TEXT, end_date TEXT, purpose TEXT, type TEXT NOT NULL, announce_date TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, parser_version TEXT NOT NULL, parsed_at TEXT NOT NULL, UNIQUE(announcement_id, shareholder, type))`,
    `CREATE TABLE IF NOT EXISTS review_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, event_type TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT, reviewer TEXT, resolution TEXT)`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sync_run (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, announcements_found INTEGER NOT NULL DEFAULT 0, events_created INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, message TEXT)`,
    `CREATE INDEX IF NOT EXISTS pledge_date_idx ON pledge (announce_date)`,
    `CREATE INDEX IF NOT EXISTS pledge_stock_idx ON pledge (stock_code)`,
    `CREATE INDEX IF NOT EXISTS pledge_shareholder_idx ON pledge (shareholder)`,
    `CREATE INDEX IF NOT EXISTS pledge_pledgee_idx ON pledge (pledgee)`,
    `CREATE INDEX IF NOT EXISTS announcement_date_idx ON announcement (announce_date)`,
  ];
  await db.batch(statements.map((sql) => db.prepare(sql)));
}

const demo = [
  ["CN202607240031","300403","汉宇集团","关于控股股东部分股份质押的公告","2026-07-24","https://www.cninfo.com.cn/","巨潮资讯","8f24c2d7a093","石华山","国泰海通证券股份有限公司",10000000,"1,000.00 万股","12.53%","3.15%","新增质押",0.992],
  ["CN202607240028","002129","TCL中环","关于股东股份解除质押的公告","2026-07-24","https://www.cninfo.com.cn/","巨潮资讯","bf31a91c3390","TCL科技集团（天津）有限公司","中国工商银行股份有限公司",32000000,"3,200.00 万股","4.27%","0.79%","解除质押",0.981],
  ["SSE202607240116","600519","贵州茅台","关于股东股份补充质押的公告","2026-07-24","https://www.sse.com.cn/","上交所","abe3821d0913","中国贵州茅台酒厂（集团）","中信证券股份有限公司",6800000,"680.00 万股","1.05%","0.54%","补充质押",0.974],
  ["SZSE202607240089","000651","格力电器","关于股东解除质押后再质押的公告","2026-07-24","https://www.szse.cn/","深交所","c91724aa7321","珠海明骏投资合伙企业","招商银行股份有限公司",24500000,"2,450.00 万股","2.71%","0.44%","解除后再质押",0.966],
  ["SSE202607230074","688981","中芯国际","关于股东股份质押的公告","2026-07-23","https://www.sse.com.cn/","上交所","8812cc784111","大唐控股（香港）投资有限公司","中国银行股份有限公司",18800000,"1,880.00 万股","3.12%","0.24%","新增质押",0.958],
] as const;

async function seed(db: D1Database) {
  const count = await db.prepare("SELECT COUNT(*) AS count FROM pledge").first<{ count: number }>();
  if ((count?.count || 0) > 0) return 0;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const r of demo) {
    statements.push(db.prepare("INSERT OR IGNORE INTO stock_info (code,name,exchange,status) VALUES (?,?,?,?)").bind(r[1],r[2],r[6],"上市"));
    statements.push(db.prepare("INSERT OR IGNORE INTO announcement (announcement_id,stock_code,stock_name,title,announce_date,pdf_url,source,crawl_time,md5,sha256,parse_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(r[0],r[1],r[2],r[3],r[4],r[5],r[6],now,r[7],r[7],"parsed"));
    statements.push(db.prepare("INSERT OR IGNORE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,type,announce_date,confidence,parser_version,parsed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(r[0],r[1],r[2],r[8],r[9],r[10],r[11],r[12],r[13],r[14],r[4],r[15],"worker-v1.0.0",now));
  }
  await db.batch(statements);
  return demo.length;
}

type CninfoAnnouncement = { secCode: string; secName: string; announcementId: string; announcementTitle: string; announcementTime: number; adjunctUrl: string };
type CninfoResult = { announcements?: CninfoAnnouncement[]; totalRecordNum?: number };
const stripHtml = (value: string) => value.replace(/<[^>]+>/g, "").replaceAll("&amp;", "&").trim();
const toDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const cleanText = (value: string) => value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
const firstMatch = (text: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanText(match[1]).replace(/[：:；;，,。]$/, "");
  }
  return "";
};
const pledgeType = (title: string) => title.includes("解除") && title.includes("再质押") ? "解除后再质押" : title.includes("解除") ? "解除质押" : title.includes("补充") ? "补充质押" : "新增质押";
const amountNumber = (value: string) => {
  const numeric = Number(value.replace(/,/g, "").match(/[\d.]+/)?.[0] || 0);
  if (/亿/.test(value)) return numeric * 100000000;
  if (/万/.test(value)) return numeric * 10000;
  return numeric;
};

function parsePledgeText(text: string, title: string) {
  const compact = cleanText(text);
  const shareholder = firstMatch(compact, [/(?:股东名称|股东姓名|出质人)[：:]?\s*([^\n]{2,80})/i, /(?:股东|出质人)\s+([^\n]{2,80})/i]);
  const pledgee = firstMatch(compact, [/(?:质权人|质权方|质押权人)[：:]?\s*([^\n]{2,100})/i, /(?:质权人|质押权人)\s+([^\n]{2,100})/i]);
  const amountText = firstMatch(compact, [/(?:本次质押(?:股数|数量)?|质押股数|质押数量|解除质押(?:股数|数量)?)[：:]?\s*([\d,.]+\s*(?:万|亿)?\s*股)/i, /([\d,.]+\s*(?:万|亿)?\s*股)\s*(?:占其所持股份|占所持股份)/i]);
  const pledgeRatio = firstMatch(compact, [/(?:占其所持股份比例|占所持股份比例)[：:]?\s*([\d.]+%)/i]);
  const totalRatio = firstMatch(compact, [/(?:占公司总股本比例|占总股本比例)[：:]?\s*([\d.]+%)/i]);
  const startDate = firstMatch(compact, [/(?:质押起始日|起始日)[：:]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/i]);
  const endDate = firstMatch(compact, [/(?:质押到期日|到期日)[：:]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?|办理解除质押登记之日)/i]);
  const purpose = firstMatch(compact, [/(?:质押用途|用途)[：:]?\s*([^\n]{2,80})/i]);
  const amount = amountNumber(amountText);
  const missing = [!shareholder && "股东", !pledgee && "质权人", !amount && "质押数量"].filter(Boolean);
  return { shareholder, pledgee, amount, amountText, pledgeRatio, totalRatio, startDate, endDate, purpose, type: pledgeType(title), missing };
}

async function processAnnouncement(db: D1Database, documents: R2Bucket, id: string) {
  const item = await db.prepare("SELECT announcement_id AS id,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,r2_key AS r2Key,sha256 FROM announcement WHERE announcement_id=?").bind(id).first<{id:string;stockCode:string;stockName:string;title:string;announceDate:string;pdfUrl:string;r2Key?:string;sha256?:string}>();
  if (!item) throw new Error("announcement not found");
  let bytes: ArrayBuffer;
  let r2Key = item.r2Key;
  let sha256 = item.sha256;
  if (r2Key) {
    const object = await documents.get(r2Key);
    if (!object) throw new Error("archived PDF not found");
    bytes = await object.arrayBuffer();
  } else {
    const response = await fetch(item.pdfUrl, { headers: { referer: "https://www.cninfo.com.cn/", "user-agent": "Mozilla/5.0 (compatible; StockEventDB/1.0)" } });
    if (!response.ok) throw new Error(`PDF download failed: ${response.status}`);
    bytes = await response.arrayBuffer();
    sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    r2Key = `announcements/${id}.pdf`;
    await documents.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { announcementId: id, sha256 } });
  }
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const extracted = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  await documents.put(`announcements/${id}.txt`, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  const parsed = parsePledgeText(text, item.title);
  const now = new Date().toISOString();
  if (parsed.missing.length) {
    await db.batch([
      db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='review' WHERE announcement_id=?").bind(r2Key, sha256, id),
      db.prepare("UPDATE review_queue SET reason=?,payload=? WHERE announcement_id=? AND status='pending'").bind(`自动解析缺少字段：${parsed.missing.join("、")}`, JSON.stringify({ ...parsed, textKey: `announcements/${id}.txt` }), id),
      db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement", id, "parse_review", JSON.stringify({ missing: parsed.missing, parserVersion: "unpdf-rules-v1" }), "worker", now),
    ]);
    return { id, status: "review", missing: parsed.missing };
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.stockCode,item.stockName,parsed.shareholder,parsed.pledgee,parsed.amount,parsed.amountText,parsed.pledgeRatio||null,parsed.totalRatio||null,parsed.startDate||null,parsed.endDate||null,parsed.purpose||null,parsed.type,item.announceDate,0.82,"unpdf-rules-v1",now),
    db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='parsed' WHERE announcement_id=?").bind(r2Key, sha256, id),
    db.prepare("UPDATE review_queue SET status='approved',reason='自动解析字段完整',reviewed_at=?,reviewer='worker',resolution=? WHERE announcement_id=? AND status='pending'").bind(now,JSON.stringify(parsed),id),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("pledge",id,"auto_parse",JSON.stringify({ ...parsed, parserVersion: "unpdf-rules-v1" }),"worker",now),
  ]);
  return { id, status: "parsed", event: parsed };
}

async function fetchCninfo(date: string) {
  const all: CninfoAnnouncement[] = [];
  for (const column of ["szse", "sse"]) {
    const body = new URLSearchParams({ pageNum: "1", pageSize: "100", column, tabName: "fulltext", plate: "", stock: "", searchkey: "质押", secid: "", category: "", trade: "", seDate: `${date}~${date}`, sortName: "", sortType: "", isHLtitle: "true" });
    const response = await fetch("https://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json, text/plain, */*", referer: "https://www.cninfo.com.cn/new/disclosure", "user-agent": "Mozilla/5.0 (compatible; StockEventDB/1.0; public-disclosure-research)" }, body });
    if (!response.ok) throw new Error(`巨潮资讯 ${column} 返回 ${response.status}`);
    const data = await response.json<CninfoResult>();
    all.push(...(data.announcements || []));
  }
  return [...new Map(all.map((item) => [item.announcementId, item])).values()];
}

async function ingestCninfo(db: D1Database, date: string) {
  const announcements = await fetchCninfo(date); const now = new Date().toISOString(); let inserted = 0;
  for (const item of announcements) {
    const title = stripHtml(item.announcementTitle); const pdfUrl = `https://static.cninfo.com.cn/${item.adjunctUrl}`;
    const existing = await db.prepare("SELECT announcement_id FROM announcement WHERE announcement_id=?").bind(item.announcementId).first();
    if (existing) continue;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO stock_info (code,name,exchange,status) VALUES (?,?,?,?)").bind(item.secCode,item.secName,item.secCode.startsWith("6") ? "上交所" : item.secCode.startsWith("9") || item.secCode.startsWith("8") ? "北交所" : "深交所","上市"),
      db.prepare("INSERT INTO announcement (announcement_id,stock_code,stock_name,title,announce_date,pdf_url,source,crawl_time,md5,parse_status) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(item.announcementId,item.secCode,item.secName,title,toDate(item.announcementTime),pdfUrl,"巨潮资讯",now,`pending:${item.announcementId}`,"queued"),
      db.prepare("INSERT INTO review_queue (announcement_id,event_type,reason,payload,status,created_at) VALUES (?,?,?,?,?,?)").bind(item.announcementId,"pledge","等待 PDF 归档与结构化解析",JSON.stringify({ stockCode:item.secCode,stockName:item.secName,title,pdfUrl }),"pending",now),
    ]);
    inserted++;
  }
  return { found: announcements.length, inserted };
}

async function api(request: Request, env: Env): Promise<Response> {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    const stats = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM announcement) announcements, (SELECT COUNT(*) FROM pledge) events, (SELECT COUNT(*) FROM review_queue WHERE status='pending') pending_reviews").first();
    return json({ status: "ok", storage: { d1: true, r2: true }, stats, timestamp: new Date().toISOString() });
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    const input = await request.json<{date?:string}>().catch(() => ({})); const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date(Date.now() - 86400000).toISOString().slice(0,10);
    const startedAt = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("official-adapters",startedAt,"running","V1 适配器初始化").first<{id:number}>();
    try {
      const result = await ingestCninfo(env.DB,date);
      await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,message=? WHERE id=?").bind(new Date().toISOString(),"completed",result.found,0,`巨潮资讯 ${date}：新增 ${result.inserted} 条待解析公告`,run?.id).run();
      return json({ ok:true,run_id:run?.id,date,announcements_found:result.found,announcements_inserted:result.inserted,events_created:0,mode:"cninfo-live" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步失败";
      await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,failures=1,message=? WHERE id=?").bind(new Date().toISOString(),"failed",message,run?.id).run();
      return json({ ok:false,run_id:run?.id,error:message },{status:502});
    }
  }
  if (url.pathname === "/api/events" && request.method === "GET") {
    const conditions: string[] = []; const values: string[] = [];
    const add = (sql: string, value: string | null) => { if (value) { conditions.push(sql); values.push(value); } };
    add("p.announce_date = ?", url.searchParams.get("date"));
    add("p.type = ?", url.searchParams.get("event_type"));
    const q = url.searchParams.get("q"); if (q) { conditions.push("(p.stock_code LIKE ? OR p.stock_name LIKE ? OR p.shareholder LIKE ? OR p.pledgee LIKE ?)"); values.push(...Array(4).fill(`%${q}%`)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,p.confidence,p.parser_version AS parserVersion,a.source,a.pdf_url AS pdfUrl,a.md5,a.sha256 FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id ${where} ORDER BY p.announce_date DESC,p.id DESC LIMIT 500`;
    const result = await env.DB.prepare(sql).bind(...values).all();
    return json({ data: result.results, total: result.results.length, traceable: true });
  }
  if (url.pathname === "/api/announcements" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT announcement_id AS announcementId,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,source,crawl_time AS crawlTime,md5,sha256,parse_status AS parseStatus FROM announcement ORDER BY announce_date DESC LIMIT 500").all();
    return json({ data: result.results, total: result.results.length });
  }
  if (url.pathname === "/api/sync-runs" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT id,source,started_at AS startedAt,finished_at AS finishedAt,status,announcements_found AS announcementsFound,events_created AS eventsCreated,failures,message FROM sync_run ORDER BY id DESC LIMIT 100").all();
    return json({ data: result.results });
  }
  if (url.pathname === "/api/process" && request.method === "POST") {
    const input = await request.json<{limit?:number}>().catch(() => ({}));
    const limit = Math.min(Math.max(Number(input.limit) || 3, 1), 10);
    const startedAt = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("pdf-parser",startedAt,"running",`开始处理最多 ${limit} 条公告`).first<{id:number}>();
    const pending = await env.DB.prepare("SELECT announcement_id AS id FROM announcement WHERE parse_status IN ('queued','archived','review') ORDER BY announce_date DESC LIMIT ?").bind(limit).all<{id:string}>();
    const results: unknown[] = [];
    let parsed = 0; let failures = 0;
    for (const row of pending.results) {
      try { const result = await processAnnouncement(env.DB, env.DOCUMENTS, row.id); results.push(result); if (result.status === "parsed") parsed++; }
      catch (error) { failures++; results.push({ id: row.id, status: "failed", error: error instanceof Error ? error.message : "parse failed" }); }
    }
    await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,failures=?,message=? WHERE id=?").bind(new Date().toISOString(),failures ? "completed_with_errors" : "completed",results.length,parsed,failures,`处理 ${results.length} 条，生成 ${parsed} 条事件，失败 ${failures} 条`,run?.id).run();
    return json({ ok: true, run_id: run?.id, processed: results.length, events_created: parsed, failures, results });
  }
  if (url.pathname.startsWith("/api/announcements/") && url.pathname.endsWith("/process") && request.method === "POST") {
    const id = url.pathname.split("/")[3];
    return json(await processAnnouncement(env.DB, env.DOCUMENTS, id));
  }
  if (url.pathname.startsWith("/api/announcements/") && url.pathname.endsWith("/archive") && request.method === "POST") {
    const id = url.pathname.split("/")[3]; const item = await env.DB.prepare("SELECT pdf_url AS pdfUrl FROM announcement WHERE announcement_id=?").bind(id).first<{pdfUrl:string}>();
    if (!item?.pdfUrl) return json({error:"announcement not found"},{status:404});
    const response = await fetch(item.pdfUrl,{headers:{referer:"https://www.cninfo.com.cn/","user-agent":"Mozilla/5.0 (compatible; StockEventDB/1.0)"}}); if (!response.ok) return json({error:`PDF download failed: ${response.status}`},{status:502});
    const bytes = await response.arrayBuffer(); const sha256 = hex(await crypto.subtle.digest("SHA-256",bytes)); const key = `announcements/${id}.pdf`;
    await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:"application/pdf"},customMetadata:{announcementId:id,sha256}});
    await env.DB.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status=? WHERE announcement_id=?").bind(key,sha256,"archived",id).run();
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",id,"archive",JSON.stringify({key,sha256,size:bytes.byteLength}),"worker",new Date().toISOString()).run();
    return json({ok:true,key,sha256,size:bytes.byteLength});
  }
  if (url.pathname === "/api/reviews" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT r.id,r.announcement_id AS announcementId,r.event_type AS eventType,r.reason,r.payload,r.status,r.created_at AS createdAt,r.reviewed_at AS reviewedAt,r.resolution,a.stock_code AS stockCode,a.stock_name AS stockName,a.title,a.announce_date AS announceDate,a.pdf_url AS pdfUrl FROM review_queue r JOIN announcement a ON a.announcement_id=r.announcement_id ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 200").all();
    return json({ data: result.results });
  }
  if (url.pathname.startsWith("/api/reviews/") && request.method === "PATCH") {
    const id = Number(url.pathname.split("/").pop());
    const body = await request.json<{status?:string;resolution?:string;shareholder?:string;pledgee?:string;amount?:number;amountText?:string;pledgeRatio?:string;totalRatio?:string;type?:string}>();
    if (!id || !["approved","rejected"].includes(body.status || "")) return json({ error: "invalid review update" }, { status: 400 });
    const before = await env.DB.prepare("SELECT * FROM review_queue WHERE id=?").bind(id).first<{announcement_id:string;status:string}>();
    if (!before) return json({ error: "review not found" }, { status: 404 });
    if (before.status !== "pending") return json({ error: "review already completed" }, { status: 409 });
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE review_queue SET status=?,resolution=?,reviewed_at=?,reviewer=? WHERE id=?").bind(body.status,body.resolution || "",now,"site-user",id),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,before_json,after_json,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind("review_queue",String(id),"review",JSON.stringify(before),JSON.stringify(body),"site-user",now),
    ];
    if (body.status === "approved") {
      const announcement = await env.DB.prepare("SELECT stock_code AS stockCode,stock_name AS stockName,announce_date AS announceDate FROM announcement WHERE announcement_id=?").bind(before.announcement_id).first<{stockCode:string;stockName:string;announceDate:string}>();
      if (!announcement || !body.shareholder?.trim() || !body.pledgee?.trim() || !Number(body.amount)) return json({ error: "股东、质权人和质押数量为必填项" }, { status: 400 });
      statements.push(
        env.DB.prepare("INSERT OR REPLACE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,type,announce_date,confidence,parser_version,parsed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(before.announcement_id,announcement.stockCode,announcement.stockName,body.shareholder.trim(),body.pledgee.trim(),Number(body.amount),body.amountText || String(body.amount),body.pledgeRatio || null,body.totalRatio || null,body.type || "新增质押",announcement.announceDate,1,"manual-review-v1",now),
        env.DB.prepare("UPDATE announcement SET parse_status='parsed' WHERE announcement_id=?").bind(before.announcement_id),
      );
    } else {
      statements.push(env.DB.prepare("UPDATE announcement SET parse_status='rejected' WHERE announcement_id=?").bind(before.announcement_id));
    }
    await env.DB.batch(statements);
    return json({ ok: true, status: body.status });
  }
  if (url.pathname === "/api/export" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT announce_date,stock_code,stock_name,shareholder,pledgee,pledge_amount_text,pledge_ratio,total_ratio,type FROM pledge ORDER BY announce_date DESC").all<Record<string, unknown>>();
    const format = url.searchParams.get("format") || "csv";
    if (format === "json") return json(result.results, { headers: { "content-disposition": "attachment; filename=pledge-events.json" } });
    const cols = ["announce_date","stock_code","stock_name","shareholder","pledgee","pledge_amount_text","pledge_ratio","total_ratio","type"];
    const csv = "\ufeff" + cols.join(",") + "\n" + result.results.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"','""')}"`).join(",")).join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=pledge-events.csv" } });
  }
  if (url.pathname.startsWith("/api/documents/") && request.method === "GET") {
    const key = decodeURIComponent(url.pathname.slice("/api/documents/".length)); const object = await env.DOCUMENTS.get(key);
    if (!object) return json({ error: "document not found" }, { status: 404 });
    return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "application/pdf", etag: object.httpEtag } });
  }
  return json({ error: "not found" }, { status: 404 });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) { try { return await api(request, env); } catch (error) { return json({ error: error instanceof Error ? error.message : "internal error" }, { status: 500 }); } }
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, { fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))), transformImage: async (body, { width, format, quality }) => { const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality }); return result.response(); } }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};
export default worker;
