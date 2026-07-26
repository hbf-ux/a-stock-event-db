import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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

async function api(request: Request, env: Env): Promise<Response> {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    const stats = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM announcement) announcements, (SELECT COUNT(*) FROM pledge) events, (SELECT COUNT(*) FROM review_queue WHERE status='pending') pending_reviews").first();
    return json({ status: "ok", storage: { d1: true, r2: true }, stats, timestamp: new Date().toISOString() });
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    const startedAt = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("official-adapters",startedAt,"running","V1 适配器初始化").first<{id:number}>();
    const created = await seed(env.DB);
    await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,message=? WHERE id=?").bind(new Date().toISOString(),"completed",created,created,created ? "初始化公开披露样例数据" : "数据已是最新",run?.id).run();
    return json({ ok: true, run_id: run?.id, announcements_found: created, events_created: created, mode: "adapter-ready" });
  }
  if (url.pathname === "/api/events" && request.method === "GET") {
    await seed(env.DB);
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
  if (url.pathname === "/api/reviews" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT * FROM review_queue ORDER BY created_at DESC LIMIT 200").all();
    return json({ data: result.results });
  }
  if (url.pathname.startsWith("/api/reviews/") && request.method === "PATCH") {
    const id = Number(url.pathname.split("/").pop()); const body = await request.json<{status?:string;resolution?:string}>();
    if (!id || !["approved","rejected"].includes(body.status || "")) return json({ error: "invalid review update" }, { status: 400 });
    const before = await env.DB.prepare("SELECT * FROM review_queue WHERE id=?").bind(id).first();
    await env.DB.batch([
      env.DB.prepare("UPDATE review_queue SET status=?,resolution=?,reviewed_at=?,reviewer=? WHERE id=?").bind(body.status,body.resolution || "",new Date().toISOString(),"site-user",id),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,before_json,after_json,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind("review_queue",String(id),"review",JSON.stringify(before),JSON.stringify(body),"site-user",new Date().toISOString()),
    ]);
    return json({ ok: true });
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
