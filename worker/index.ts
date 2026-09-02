import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { extractText, getDocumentProxy } from "unpdf";
import { isRelevantSharePledgeTitle, parseSectionPledgeRows, validateAndNormalizePledgeRow } from "./pledge-parser";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
  /** OpenAI is a targeted fallback for PDFs that deterministic rules cannot parse safely. */
  OPENAI_API_KEY?: string;
  OPENAI_OCR_MODEL?: string;
  /** Request-driven production catch-up. Disable explicitly with "false". */
  AUTO_SYNC_ENABLED?: string;
  AUTO_SYNC_INTERVAL_MINUTES?: string;
  /** Comma-separated Sites account user IDs and/or emails allowed to mutate production data. */
  ADMIN_USER_IDS?: string;
  ADMIN_EMAILS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_TEAM_MONTHLY?: string;
  STRIPE_PRICE_GLOBAL_MONTHLY?: string;
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers || {}) } });
const viewerId = (request: Request) => request.headers.get("oai-authenticated-user-id")?.trim() || null;
const viewerEmail = (request: Request) => request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() || null;
const commaSeparatedSet = (value?: string) => new Set((value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
const adminViewer = (request: Request, env: Env) => {
  const id = viewerId(request);
  const email = viewerEmail(request);
  if (!id) return null;
  const ids = commaSeparatedSet(env.ADMIN_USER_IDS);
  const emails = commaSeparatedSet(env.ADMIN_EMAILS);
  return ids.has(id.toLowerCase()) || Boolean(email && emails.has(email)) ? id : null;
};
const adminRequired = () => json({ error: "仅运营管理员可执行此操作" }, { status: 403 });
const matchStages = new Set(["reviewing","contacted","due_diligence","negotiating","completed","declined"]);

async function ensureSchema(db: D1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS stock_info (code TEXT PRIMARY KEY, name TEXT NOT NULL, exchange TEXT NOT NULL, industry TEXT, list_date TEXT, status TEXT NOT NULL DEFAULT '上市')`,
    `CREATE TABLE IF NOT EXISTS announcement (announcement_id TEXT PRIMARY KEY, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, title TEXT NOT NULL, announce_date TEXT NOT NULL, pdf_url TEXT, r2_key TEXT, source TEXT NOT NULL, crawl_time TEXT NOT NULL, md5 TEXT NOT NULL UNIQUE, sha256 TEXT, parse_status TEXT NOT NULL DEFAULT 'pending', parse_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
    `CREATE TABLE IF NOT EXISTS pledge (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, shareholder TEXT NOT NULL, pledgee TEXT NOT NULL, pledge_amount REAL NOT NULL, pledge_amount_text TEXT NOT NULL, pledge_ratio TEXT, total_ratio TEXT, start_date TEXT, end_date TEXT, purpose TEXT, type TEXT NOT NULL, announce_date TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, parser_version TEXT NOT NULL, parsed_at TEXT NOT NULL, event_fingerprint TEXT UNIQUE, verification_status TEXT NOT NULL DEFAULT 'rules_validated', verified_at TEXT, verified_by TEXT, evidence_json TEXT NOT NULL DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS review_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, event_type TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT, reviewer TEXT, resolution TEXT)`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sync_run (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, announcements_found INTEGER NOT NULL DEFAULT 0, events_created INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, message TEXT)`,
    `CREATE TABLE IF NOT EXISTS daily_report (date TEXT PRIMARY KEY, cutoff_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', announcement_count INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0, company_count INTEGER NOT NULL DEFAULT 0, reconciliation_status TEXT NOT NULL DEFAULT 'pending', report_version INTEGER NOT NULL DEFAULT 1, published_at TEXT, published_by TEXT, notes TEXT)`,
    `CREATE INDEX IF NOT EXISTS daily_report_status_date_idx ON daily_report (status,date)`,
    `CREATE TABLE IF NOT EXISTS pipeline_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS subscription_interest (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, plan TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'pricing-modal', created_at TEXT NOT NULL, UNIQUE(email, plan))`,
    `CREATE TABLE IF NOT EXISTS user_watchlist (user_id TEXT NOT NULL, stock_code TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, stock_code))`,
    `CREATE INDEX IF NOT EXISTS user_watchlist_user_idx ON user_watchlist (user_id)`,
    `CREATE TABLE IF NOT EXISTS shareholder_profile (stock_code TEXT NOT NULL, shareholder TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT '股东', is_controller INTEGER NOT NULL DEFAULT 0, is_controlling_shareholder INTEGER NOT NULL DEFAULT 0, holding_shares REAL, holding_ratio TEXT, source_title TEXT, source_url TEXT, source_date TEXT, confidence REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (stock_code, shareholder))`,
    `CREATE INDEX IF NOT EXISTS shareholder_profile_stock_idx ON shareholder_profile (stock_code)`,
    `CREATE TABLE IF NOT EXISTS exchange_observation (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_announcement_id TEXT NOT NULL, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, title TEXT NOT NULL, announce_date TEXT NOT NULL, pdf_url TEXT, title_fingerprint TEXT NOT NULL, match_status TEXT NOT NULL DEFAULT 'unmatched', match_method TEXT, matched_announcement_id TEXT, review_status TEXT NOT NULL DEFAULT 'pending', reviewed_at TEXT, reviewed_by TEXT, review_note TEXT, raw_json TEXT NOT NULL, observed_at TEXT NOT NULL, UNIQUE(source,source_announcement_id))`,
    `CREATE INDEX IF NOT EXISTS exchange_observation_date_status_idx ON exchange_observation (announce_date,match_status)`,
    `CREATE INDEX IF NOT EXISTS exchange_observation_stock_date_idx ON exchange_observation (stock_code,announce_date)`,
    `CREATE TABLE IF NOT EXISTS match_request (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, organization TEXT NOT NULL, contact_name TEXT NOT NULL, email TEXT NOT NULL, stock_code TEXT, shareholder TEXT, amount_min REAL NOT NULL, amount_max REAL NOT NULL, term_months INTEGER, preference TEXT, purpose TEXT, notes TEXT, risk_snapshot TEXT, status TEXT NOT NULL DEFAULT 'new', viewer_id TEXT, request_fingerprint TEXT NOT NULL UNIQUE, consent_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS match_request_role_status_idx ON match_request (role,status)`,
    `CREATE INDEX IF NOT EXISTS match_request_created_idx ON match_request (created_at)`,
    `CREATE INDEX IF NOT EXISTS match_request_email_created_idx ON match_request (email,created_at)`,
    `CREATE TABLE IF NOT EXISTS match_candidate (id INTEGER PRIMARY KEY AUTOINCREMENT, capital_request_id INTEGER NOT NULL, financing_request_id INTEGER NOT NULL, score INTEGER NOT NULL, reasons TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', capital_consented INTEGER NOT NULL DEFAULT 0, financing_consented INTEGER NOT NULL DEFAULT 0, capital_consented_at TEXT, financing_consented_at TEXT, capital_stage TEXT NOT NULL DEFAULT 'reviewing', financing_stage TEXT NOT NULL DEFAULT 'reviewing', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(capital_request_id,financing_request_id))`,
    `CREATE INDEX IF NOT EXISTS match_candidate_capital_status_idx ON match_candidate (capital_request_id,status)`,
    `CREATE INDEX IF NOT EXISTS match_candidate_financing_status_idx ON match_candidate (financing_request_id,status)`,
    `CREATE TABLE IF NOT EXISTS billing_account (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT UNIQUE, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'inactive', current_period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS billing_event (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_hash TEXT NOT NULL, processed_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS pledge_date_idx ON pledge (announce_date)`,
    `CREATE INDEX IF NOT EXISTS pledge_stock_idx ON pledge (stock_code)`,
    `CREATE INDEX IF NOT EXISTS pledge_shareholder_idx ON pledge (shareholder)`,
    `CREATE INDEX IF NOT EXISTS pledge_pledgee_idx ON pledge (pledgee)`,
    `CREATE INDEX IF NOT EXISTS announcement_date_idx ON announcement (announce_date)`,
  ];
  await db.batch(statements.map((sql) => db.prepare(sql)));
  // Recover runs interrupted by an isolate restart so the operations page does not
  // report a job as running forever. Keep the original row for auditability.
  await db.prepare("UPDATE sync_run SET status='failed', finished_at=?, failures=failures+1, message=COALESCE(message,'') || '；运行实例超时，已自动标记失败' WHERE status='running' AND started_at < datetime('now','-30 minutes')").bind(new Date().toISOString()).run();
  const announcementColumns = await db.prepare("PRAGMA table_info(announcement)").all<{name:string}>();
  const names = new Set(announcementColumns.results.map((column) => column.name));
  if (!names.has("parse_attempts")) await db.prepare("ALTER TABLE announcement ADD COLUMN parse_attempts INTEGER NOT NULL DEFAULT 0").run();
  if (!names.has("last_error")) await db.prepare("ALTER TABLE announcement ADD COLUMN last_error TEXT").run();
  await db.prepare("UPDATE announcement SET parse_status=CASE WHEN parse_attempts>=3 THEN 'review' ELSE 'queued' END,last_error=COALESCE(last_error,'解析任务中断，已自动恢复') WHERE parse_status='processing' AND announcement_id IN (SELECT entity_id FROM audit_log WHERE entity_type='announcement' AND action='parse_claim' GROUP BY entity_id HAVING MAX(julianday(created_at))<julianday('now','-5 minutes'))").run();
  const matchCandidateColumns = await db.prepare("PRAGMA table_info(match_candidate)").all<{name:string}>();
  const matchCandidateNames = new Set(matchCandidateColumns.results.map((column) => column.name));
  if (!matchCandidateNames.has("capital_stage")) await db.prepare("ALTER TABLE match_candidate ADD COLUMN capital_stage TEXT NOT NULL DEFAULT 'reviewing'").run();
  if (!matchCandidateNames.has("financing_stage")) await db.prepare("ALTER TABLE match_candidate ADD COLUMN financing_stage TEXT NOT NULL DEFAULT 'reviewing'").run();
  const observationColumns = await db.prepare("PRAGMA table_info(exchange_observation)").all<{name:string}>();
  const observationNames = new Set(observationColumns.results.map((column) => column.name));
  if (!observationNames.has("review_status")) await db.prepare("ALTER TABLE exchange_observation ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'").run();
  if (!observationNames.has("reviewed_at")) await db.prepare("ALTER TABLE exchange_observation ADD COLUMN reviewed_at TEXT").run();
  if (!observationNames.has("reviewed_by")) await db.prepare("ALTER TABLE exchange_observation ADD COLUMN reviewed_by TEXT").run();
  if (!observationNames.has("review_note")) await db.prepare("ALTER TABLE exchange_observation ADD COLUMN review_note TEXT").run();
  // Clear legacy false differences when the exchange row already has a
  // deterministic one-to-one primary announcement match.
  await db.prepare("UPDATE exchange_observation SET review_status='linked',reviewed_at=COALESCE(reviewed_at,?),reviewed_by=COALESCE(reviewed_by,'deterministic-reconciliation'),review_note=COALESCE(review_note,'同股票同日期只有一个质押公告候选，自动关联主库') WHERE review_status='pending' AND match_status='likely' AND match_method='single-pledge-candidate-same-stock-date' AND matched_announcement_id IS NOT NULL").bind(new Date().toISOString()).run();
  const pledgeColumns = await db.prepare("PRAGMA table_info(pledge)").all<{name:string}>();
  if (!pledgeColumns.results.some((column) => column.name === "event_fingerprint")) {
    await db.batch([
      db.prepare(`CREATE TABLE pledge_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, shareholder TEXT NOT NULL, pledgee TEXT NOT NULL, pledge_amount REAL NOT NULL, pledge_amount_text TEXT NOT NULL, pledge_ratio TEXT, total_ratio TEXT, start_date TEXT, end_date TEXT, purpose TEXT, type TEXT NOT NULL, announce_date TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, parser_version TEXT NOT NULL, parsed_at TEXT NOT NULL, event_fingerprint TEXT UNIQUE)`),
      db.prepare(`INSERT INTO pledge_v2 (id,announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at,event_fingerprint) SELECT id,announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at,'legacy:' || id FROM pledge`),
      db.prepare("DROP TABLE pledge"),
      db.prepare("ALTER TABLE pledge_v2 RENAME TO pledge"),
      db.prepare("CREATE INDEX pledge_date_idx ON pledge (announce_date)"),
      db.prepare("CREATE INDEX pledge_stock_idx ON pledge (stock_code)"),
      db.prepare("CREATE INDEX pledge_shareholder_idx ON pledge (shareholder)"),
      db.prepare("CREATE INDEX pledge_pledgee_idx ON pledge (pledgee)"),
    ]);
  }
  const verificationColumns = await db.prepare("PRAGMA table_info(pledge)").all<{name:string}>();
  const verificationNames = new Set(verificationColumns.results.map((column) => column.name));
  if (!verificationNames.has("verification_status")) await db.prepare("ALTER TABLE pledge ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'rules_validated'").run();
  if (!verificationNames.has("verified_at")) await db.prepare("ALTER TABLE pledge ADD COLUMN verified_at TEXT").run();
  if (!verificationNames.has("verified_by")) await db.prepare("ALTER TABLE pledge ADD COLUMN verified_by TEXT").run();
  if (!verificationNames.has("evidence_json")) await db.prepare("ALTER TABLE pledge ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}'").run();
  await db.prepare("UPDATE pledge SET verification_status=CASE WHEN parser_version LIKE 'manual-%' THEN 'human_verified' WHEN parser_version LIKE 'openai-%' THEN 'ai_reviewed' ELSE 'rules_validated' END,verified_at=CASE WHEN parser_version LIKE 'manual-%' OR parser_version LIKE 'openai-%' THEN COALESCE(verified_at,parsed_at) ELSE verified_at END,verified_by=CASE WHEN parser_version LIKE 'manual-%' THEN COALESCE(verified_by,'legacy-reviewer') WHEN parser_version LIKE 'openai-%' THEN COALESCE(verified_by,'openai') ELSE COALESCE(verified_by,'rules-engine') END WHERE verified_by IS NULL OR (parser_version LIKE 'manual-%' AND verification_status!='human_verified') OR (parser_version LIKE 'openai-%' AND verification_status!='ai_reviewed')").run();
  await db.batch([
    db.prepare("UPDATE pledge SET shareholder=REPLACE(REPLACE(shareholder,' ',''),'　',''),pledgee=REPLACE(REPLACE(pledgee,' ',''),'　','') WHERE shareholder LIKE '% %' OR shareholder LIKE '%　%' OR pledgee LIKE '% %' OR pledgee LIKE '%　%'"),
    db.prepare("UPDATE pledge SET pledgee=SUBSTR(pledgee,2) WHERE pledgee LIKE '日%' AND (pledgee LIKE '%有限公司' OR pledgee LIKE '%支行')"),
  ]);
  const existingEvents = await db.prepare("SELECT id,announcement_id,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,type FROM pledge").all<{id:number;announcement_id:string;shareholder:string;pledgee:string;pledge_amount:number;pledge_amount_text:string;pledge_ratio:string;total_ratio:string;type:string}>();
  const normalizedEvents = existingEvents.results.map((event) => ({event,normalized:validateAndNormalizePledgeRow({shareholder:event.shareholder,pledgee:event.pledgee,amount:Number(event.pledge_amount),amountText:event.pledge_amount_text,pledgeRatio:event.pledge_ratio || "",totalRatio:event.total_ratio || "",type:event.type,missing:[]})}));
  const entityUpdates = normalizedEvents.filter(({event,normalized}) => !normalized.missing.length && (event.shareholder !== normalized.shareholder || event.pledgee !== normalized.pledgee));
  if (entityUpdates.length) await db.batch(entityUpdates.map(({event,normalized}) => db.prepare("UPDATE pledge SET shareholder=?,pledgee=? WHERE id=?").bind(normalized.shareholder,normalized.pledgee,event.id)));
  const ids = [...new Set(normalizedEvents.filter(({normalized}) => normalized.missing.length).map(({event}) => event.announcement_id))];
  if (ids.length) {
    for (const id of ids) await db.batch([
      db.prepare("DELETE FROM pledge WHERE announcement_id=?").bind(id),
      db.prepare("UPDATE announcement SET parse_status='review',last_error='strict data quality validation rejected parser output' WHERE announcement_id=?").bind(id),
      db.prepare("UPDATE review_queue SET status='pending',reviewed_at=NULL,reviewer=NULL,reason='严格数据校验未通过：实体、数量或比例需要复核' WHERE announcement_id=?").bind(id),
    ]);
  }
  await db.prepare("DELETE FROM pledge WHERE id NOT IN (SELECT MIN(id) FROM pledge GROUP BY announcement_id,shareholder,pledgee,pledge_amount_text,pledge_ratio,total_ratio,type,announce_date)").run();
  const excludedTitleWhere = "title LIKE '%债券%质押式回购%' OR title LIKE '%质押式回购%债券%' OR title LIKE '%抵质押担保%' OR title LIKE '%知识产权质押%' OR title LIKE '%应收账款质押%' OR title LIKE '%拟签署%质押合同%' OR title LIKE '%子公司%股权质押%' OR title LIKE '%股权质押%子公司%'";
  const ignoredAt = new Date().toISOString();
  await db.batch([
    db.prepare(`DELETE FROM pledge WHERE announcement_id IN (SELECT announcement_id FROM announcement WHERE ${excludedTitleWhere})`),
    db.prepare(`UPDATE review_queue SET status='rejected',reason='非股东股份质押事件，已由标题语义过滤',reviewed_at=?,reviewer='worker',resolution='excluded-non-share-pledge' WHERE status='pending' AND announcement_id IN (SELECT announcement_id FROM announcement WHERE ${excludedTitleWhere})`).bind(ignoredAt),
    db.prepare(`UPDATE announcement SET parse_status='ignored',last_error='excluded non-share pledge announcement' WHERE ${excludedTitleWhere}`),
  ]);
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
const shanghaiDate = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86400000));
const toDate = (timestamp: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
const isTradingDate = (date: string) => { const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return day !== 0 && day !== 6; };
const addDays = (date: string, days: number) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0,10); };
const latestTradingDate = () => { let date=shanghaiDate(); while(!isTradingDate(date)) date=addDays(date,-1); return date; };
const automaticProductionTargetDate = () => {
  const hour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Shanghai",hour:"2-digit",hour12:false}).format(new Date()));
  let date=shanghaiDate();
  if(hour<20)date=addDays(date,-1);
  while(!isTradingDate(date))date=addDays(date,-1);
  return date;
};
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
type MatchRequestRecord = { id:number;role:string;amountMin:number;amountMax:number;termMonths:number|null;preference:string|null;purpose:string|null;riskSnapshot:string|null;viewerId:string|null };
async function refreshMatchCandidates(db:D1Database,requestId:number) {
  const current = await db.prepare("SELECT id,role,amount_min AS amountMin,amount_max AS amountMax,term_months AS termMonths,preference,purpose,risk_snapshot AS riskSnapshot,viewer_id AS viewerId FROM match_request WHERE id=? AND status IN ('new','active','matched')").bind(requestId).first<MatchRequestRecord>();
  if (!current) return 0;
  const oppositeRoles = current.role === "capital" ? "('financing','advisor')" : "('capital')";
  const candidates = await db.prepare(`SELECT id,role,amount_min AS amountMin,amount_max AS amountMax,term_months AS termMonths,preference,purpose,risk_snapshot AS riskSnapshot,viewer_id AS viewerId FROM match_request WHERE role IN ${oppositeRoles} AND status IN ('new','active','matched') AND id!=? AND (viewer_id IS NULL OR viewer_id!=?) ORDER BY created_at DESC LIMIT 200`).bind(current.id,current.viewerId || "").all<MatchRequestRecord>();
  const now = new Date().toISOString(); let created = 0;
  for (const candidate of candidates.results) {
    const capital = current.role === "capital" ? current : candidate;
    const financing = current.role === "capital" ? candidate : current;
    const overlapMin = Math.max(capital.amountMin,financing.amountMin);
    const overlapMax = Math.min(capital.amountMax,financing.amountMax);
    if (overlapMax < overlapMin) continue;
    const reasons:string[] = [`金额区间重合 ${Math.round(overlapMin/10000).toLocaleString("zh-CN")}–${Math.round(overlapMax/10000).toLocaleString("zh-CN")} 万元`];
    let score = 55;
    if (capital.termMonths && financing.termMonths) {
      const difference = Math.abs(capital.termMonths-financing.termMonths);
      if (difference <= 3) { score += 25; reasons.push("期限偏差不超过 3 个月"); }
      else if (difference <= 6) { score += 15; reasons.push("期限偏差不超过 6 个月"); }
      else if (difference <= 12) { score += 5; reasons.push("期限仍在可复核范围"); }
    } else { score += 8; reasons.push("一方期限开放，需人工确认"); }
    if (financing.riskSnapshot) { score += 10; reasons.push("已附官方质押事件摘要"); }
    if (capital.preference && financing.purpose) { score += 5; reasons.push("双方均已填写业务偏好"); }
    score = Math.min(100,score);
    await db.prepare("INSERT INTO match_candidate (capital_request_id,financing_request_id,score,reasons,status,capital_consented,financing_consented,created_at,updated_at) VALUES (?,?,?,?,'candidate',0,0,?,?) ON CONFLICT(capital_request_id,financing_request_id) DO UPDATE SET score=excluded.score,reasons=excluded.reasons,updated_at=excluded.updated_at").bind(capital.id,financing.id,score,JSON.stringify(reasons),now,now).run();
    created++;
  }
  return created;
}
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve,milliseconds));
async function withDeadline<T>(work:Promise<T>,milliseconds:number,label:string):Promise<T>{
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<T>((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`${label} exceeded ${Math.round(milliseconds/1000)} seconds`)),milliseconds);})]);}
  finally{if(timeout)clearTimeout(timeout);}
}
async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("official source request timed out"), 12_000);
    try {
      const response = await fetch(input,{...init,signal:controller.signal});
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      if (attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    finally { clearTimeout(timeout); }
    if (attempt < attempts) await wait(300 * 3 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error("request failed after retries");
}

const cleanText = (value: string) => value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
const firstMatch = (text: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanText(match[1]).replace(/[：:；;，,。]$/, "");
  }
  return "";
};
const pledgeType = (title: string) => title.includes("延期") || title.includes("展期") ? "质押展期" : title.includes("解除") && (title.includes("再质押") || title.includes("继续质押")) ? "解除后再质押" : title.includes("解除") ? "解除质押" : title.includes("补充") ? "补充质押" : "新增质押";

type OfficialCorrectionEvent = {shareholder:string;pledgee:string;amount:number;amountText:string;pledgeRatio:string;totalRatio:string;startDate:string;endDate:string;purpose:string;type:string};
type OfficialCorrection = {stockCode:string;stockName:string;events:OfficialCorrectionEvent[]};

const OFFICIAL_DATE_CORRECTIONS:Record<string,OfficialCorrection[]>={
  "2026-08-31":[
    {stockCode:"300432",stockName:"富临精工",events:[
      {shareholder:"四川富临实业集团有限公司",pledgee:"中国银河证券股份有限公司",amount:13600000,amountText:"13,600,000 股",pledgeRatio:"2.62%",totalRatio:"0.80%",startDate:"2026-01-15",endDate:"2026-08-28",purpose:"",type:"解除质押"},
    ]},
    {stockCode:"300538",stockName:"同益股份",events:[
      {shareholder:"邵羽南",pledgee:"深圳市高新投小额贷款有限公司",amount:1000000,amountText:"1,000,000 股",pledgeRatio:"3.49%",totalRatio:"0.55%",startDate:"2026-08-28",endDate:"至解除质押登记日止",purpose:"置换存量股权质押融资",type:"新增质押"},
      {shareholder:"华青翠",pledgee:"深圳市高新投小额贷款有限公司",amount:7350000,amountText:"7,350,000 股",pledgeRatio:"18.86%",totalRatio:"4.04%",startDate:"2026-08-28",endDate:"至解除质押登记日止",purpose:"置换存量股权质押融资",type:"新增质押"},
    ]},
    {stockCode:"300558",stockName:"贝达药业",events:[
      {shareholder:"宁波凯铭投资管理合伙企业（有限合伙）",pledgee:"渤海国际信托股份有限公司",amount:9300000,amountText:"9,300,000 股",pledgeRatio:"11.62%",totalRatio:"2.20%",startDate:"2026-08-28",endDate:"2027-08-30",purpose:"自身经营",type:"新增质押"},
      {shareholder:"宁波凯铭投资管理合伙企业（有限合伙）",pledgee:"山东省国际信托股份有限公司",amount:10730000,amountText:"10,730,000 股",pledgeRatio:"13.40%",totalRatio:"2.53%",startDate:"2026-02-26",endDate:"2026-08-31",purpose:"",type:"解除质押"},
    ]},
    {stockCode:"300654",stockName:"世纪天鸿",events:[
      {shareholder:"山东志鸿教育投资（集团）有限公司",pledgee:"国金证券股份有限公司",amount:3320000,amountText:"3,320,000 股",pledgeRatio:"2.07%",totalRatio:"0.91%",startDate:"2025-09-09",endDate:"2026-08-28",purpose:"",type:"解除质押"},
    ]},
    {stockCode:"300832",stockName:"新产业",events:[
      {shareholder:"西藏新产业投资管理有限公司",pledgee:"华泰证券股份有限公司",amount:12060000,amountText:"1,206.00万 股",pledgeRatio:"5.7108%",totalRatio:"1.5349%",startDate:"2025-08-28",endDate:"2027-08-27",purpose:"偿还负债；原到期日2026-08-28",type:"质押展期"},
      {shareholder:"西藏新产业投资管理有限公司",pledgee:"华泰证券股份有限公司",amount:2000000,amountText:"200.00万 股",pledgeRatio:"0.9471%",totalRatio:"0.2545%",startDate:"2026-07-08",endDate:"2027-08-27",purpose:"补充质押；原到期日2026-08-28",type:"质押展期"},
    ]},
    {stockCode:"301291",stockName:"明阳电气",events:[
      {shareholder:"中山市明阳电器有限公司",pledgee:"国通信托有限责任公司",amount:10000000,amountText:"10,000,000 股",pledgeRatio:"7.66%",totalRatio:"3.18%",startDate:"2026-08-28",endDate:"至办理解除质押登记为止",purpose:"日常经营",type:"新增质押"},
    ]},
    {stockCode:"301316",stockName:"慧博云通",events:[
      {shareholder:"舟山慧博创展创业投资合伙企业（有限合伙）",pledgee:"云南国际信托有限公司",amount:2850000,amountText:"2,850,000 股",pledgeRatio:"4.75%",totalRatio:"0.71%",startDate:"2025-08-26",endDate:"2026-08-28",purpose:"",type:"解除质押"},
      {shareholder:"舟山慧博创展创业投资合伙企业（有限合伙）",pledgee:"云南国际信托有限公司",amount:2900000,amountText:"2,900,000 股",pledgeRatio:"4.83%",totalRatio:"0.72%",startDate:"2025-08-26",endDate:"2026-08-28",purpose:"",type:"解除质押"},
    ]},
    {stockCode:"301589",stockName:"诺瓦星云",events:[
      {shareholder:"袁胜春",pledgee:"华能贵诚信托有限公司",amount:2460000,amountText:"2,460,000 股",pledgeRatio:"11.53%",totalRatio:"2.66%",startDate:"2026-01-12",endDate:"2026-08-28",purpose:"",type:"解除质押"},
      {shareholder:"宗靖国",pledgee:"华能贵诚信托有限公司",amount:2460000,amountText:"2,460,000 股",pledgeRatio:"17.40%",totalRatio:"2.66%",startDate:"2026-01-12",endDate:"2026-08-28",purpose:"",type:"解除质押"},
    ]},
    {stockCode:"920914",stockName:"远航精密",events:[
      {shareholder:"江苏远航时代控股集团有限公司",pledgee:"华夏银行股份有限公司宜兴支行",amount:6500000,amountText:"6,500,000 股",pledgeRatio:"16.39%",totalRatio:"6.52%",startDate:"2025-01-17",endDate:"2026-08-27",purpose:"",type:"解除质押"},
      {shareholder:"江苏远航时代控股集团有限公司",pledgee:"华夏银行股份有限公司宜兴支行",amount:6500000,amountText:"6,500,000 股",pledgeRatio:"16.39%",totalRatio:"6.52%",startDate:"2026-08-27",endDate:"至办理解除质押登记手续止",purpose:"为增持专项贷款提供担保",type:"解除后再质押"},
    ]},
  ],
};
const amountNumber = (value: string) => {
  const numeric = Number(value.replace(/,/g, "").match(/[\d.]+/)?.[0] || 0);
  if (/亿/.test(value)) return numeric * 100000000;
  if (/万/.test(value)) return numeric * 10000;
  return numeric;
};

function parsePledgeText(text: string, title: string) {
  const compact = cleanText(text);
  const shareholder = firstMatch(compact, [/(?:股东名称|股东姓名|出质人)[：:]?\s*([^\n]{2,80})/i, /(?:股东|出质人)\s+([^\n]{2,80})/i]);
  const pledgee = firstMatch(compact, [/质押给\s*([^，。]{2,60}?(?:有限责任公司|有限公司))/i, /(?:质权人|质权方|质押权人)[：:]?\s*([^\n]{2,100})/i, /(?:质权人|质押权人)\s+([^\n]{2,100})/i]);
  const amountText = firstMatch(compact, [/(?:本次质押(?:股数|数量)?|质押股数|质押数量|解除质押(?:股数|数量)?)[：:]?\s*([\d,.]+\s*(?:万|亿)?\s*股)/i, /([\d,.]+\s*(?:万|亿)?\s*股)\s*(?:占其所持股份|占所持股份|占公司总股本)/i]);
  const pledgeRatio = firstMatch(compact, [/(?:占其所持股份比例|占所持股份比例)[：:]?\s*([\d.]+%)/i]);
  const totalRatio = firstMatch(compact, [/(?:占公司总股本比例|占总股本比例)[：:]?\s*([\d.]+%)/i]);
  const startDate = firstMatch(compact, [/(?:质押起始日|起始日)[：:]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/i]);
  const endDate = firstMatch(compact, [/(?:质押到期日|到期日)[：:]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?|办理解除质押登记之日)/i]);
  const purpose = firstMatch(compact, [/(?:质押用途|用途)[：:]?\s*([^\n]{2,80})/i]);
  const amount = amountNumber(amountText);
  const missing = [!shareholder && "股东", !pledgee && "质权人", !amount && "质押数量"].filter(Boolean);
  return { shareholder, pledgee, amount, amountText, pledgeRatio, totalRatio, startDate, endDate, purpose, type: pledgeType(title), missing };
}

type ParsedPledge = ReturnType<typeof parsePledgeText>;

function parseFlattenedTableRows(text: string, title: string): ParsedPledge[] {
  const flat = text.replace(/\r?\n/g," ").replace(/\s+/g," ").trim();
  const namedPeople = [...new Set([...flat.matchAll(/([\u4e00-\u9fff·]{2,4})\s*(?:先生|女士)/g)].map((match) => match[1]))];
  const rowPattern = /([\u4e00-\u9fff·](?:\s*[\u4e00-\u9fff·]){1,19})\s+是\s+([\d,.]+)\s*(?:股)?\s+([\d.]+)%?\s+([\d.]+)%?\s+(.{0,260}?)(?=(?:[\u4e00-\u9fff·](?:\s*[\u4e00-\u9fff·]){1,19}\s+是\s+[\d,.]+\s+(?:股\s+)?[\d.]+%?)|\s+合计\s|\s+[二三四五六]、|$)/g;
  const rows: ParsedPledge[] = []; let previousShareholder = "";
  for (const match of flat.matchAll(rowPattern)) {
    let shareholder = match[1].replace(/\s/g,"").replace(/^.*(?:质押用途|用途|质权人|到期日|起始日|限售股)/,"");
    const namedPerson = namedPeople.filter((name) => shareholder.endsWith(name)).sort((a,b) => b.length-a.length)[0];
    if (namedPerson) shareholder = namedPerson;
    else {
      const suffixPerson = [4,3,2].map((length) => shareholder.slice(-length)).find((name) => flat.includes(`${name}先生`) || flat.includes(`${name}女士`));
      if (suffixPerson) shareholder = suffixPerson;
    }
    if ((shareholder.length > 10 || /(借款|质押|融资|用途|证券|银行|信托)/.test(shareholder)) && previousShareholder) shareholder = previousShareholder;
    else if (shareholder.length > 10 || /(借款|质押|融资|用途|证券|银行|信托)/.test(shareholder)) shareholder = "";
    const amountText = `${match[2]} 股`; const tail = match[5];
    const dates = [...tail.matchAll(/\d{4}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?/g)].map((item) => item[0].replace(/\s/g,""));
    const compactTail = tail.replace(/\s/g,""); const organizationMatches = [...compactTail.matchAll(/[\u4e00-\u9fff（）()]{2,30}(?:股份有限公司|有限责任公司|有限公司)/g)];
    let pledgee = organizationMatches.at(-1)?.[0] || "";
    pledgee = pledgee.replace(/^.*(?:为止|日期|到期日|解除质押日|否|是)/,"");
    const amount = amountNumber(amountText); const missing = [!shareholder && "股东", !pledgee && "质权人", !amount && "质押数量"].filter(Boolean);
    rows.push({shareholder,pledgee,amount,amountText,pledgeRatio:`${match[3]}%`,totalRatio:`${match[4]}%`,startDate:dates[0] || "",endDate:dates[1] || "",purpose:"",type:pledgeType(title),missing});
    if (!missing.length) previousShareholder = shareholder;
  }
  return rows.filter((row) => row.shareholder !== "股东名称" && row.shareholder !== "股东");
}

function parsePledgeRows(text: string, title: string): ParsedPledge[] {
  const sectionRows = parseSectionPledgeRows(text,title) as ParsedPledge[];
  if (sectionRows.length) return sectionRows;
  const fallback = parsePledgeText(text, title);
  const flattenedRows = parseFlattenedTableRows(text,title);
  if (flattenedRows.some((row) => !row.missing.length)) return flattenedRows;
  const rows: ParsedPledge[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanText(rawLine);
    const amountText = line.match(/[\d,.]+\s*(?:万|亿)?\s*股/)?.[0] || "";
    const percentages = [...line.matchAll(/[\d.]+%/g)].map((match) => match[0]);
    if (!amountText || percentages.length < 1) continue;
    const cells = rawLine.split(/\t|\s{2,}/).map(cleanText).filter(Boolean);
    const amountIndex = cells.findIndex((cell) => cell.includes(amountText.replace(/\s/g, "")) || cleanText(cell).includes(cleanText(amountText)));
    if (amountIndex < 1) continue;
    const before = cells.slice(0, amountIndex).filter((cell) => !/^(序号|名称|股东|出质人)$/.test(cell));
    const after = cells.slice(amountIndex + 1);
    const shareholder = before[0] || fallback.shareholder;
    const pledgee = after.find((cell) => /(银行|证券|信托|公司|质权人)/.test(cell) && !cell.includes("%")) || before[1] || fallback.pledgee;
    const amount = amountNumber(amountText);
    const key = `${shareholder}|${pledgee}|${amountText}|${percentages.join("|")}`;
    if (!shareholder || !pledgee || !amount || seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...fallback, shareholder, pledgee, amount, amountText, pledgeRatio: percentages[0] || "", totalRatio: percentages[1] || "", missing: [] });
  }
  if (!rows.length || (!fallback.missing.length && !rows.some((row) => row.shareholder === fallback.shareholder && row.amount === fallback.amount))) rows.unshift(fallback);
  return rows.filter((row, index, all) => index === all.findIndex((other) => `${other.shareholder}|${other.pledgee}|${other.amountText}|${other.type}` === `${row.shareholder}|${row.pledgee}|${row.amountText}|${row.type}`));
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
};

function normalizeVisionRows(value: unknown, title: string): ParsedPledge[] {
  const source = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray((value as {events?:unknown[]}).events) ? (value as {events:unknown[]}).events : []);
  return source.map((entry) => {
    const row = entry as Record<string, unknown>; const amountText = String(row.pledge_amount ?? row.amount ?? "");
    const parsed = { shareholder:String(row.shareholder ?? "").trim(), pledgee:String(row.pledgee ?? "").trim(), amount:amountNumber(amountText), amountText, pledgeRatio:String(row.pledge_ratio ?? ""), totalRatio:String(row.total_ratio ?? ""), startDate:String(row.start_date ?? ""), endDate:String(row.end_date ?? ""), purpose:String(row.purpose ?? ""), type:String(row.type ?? pledgeType(title)), missing:[] as unknown[] };
    parsed.missing = [!parsed.shareholder && "股东", !parsed.pledgee && "质权人", !parsed.amount && "质押数量"].filter(Boolean);
    return parsed as ParsedPledge;
  });
}

const validateParsedRows = (rows: ParsedPledge[]) => rows.map((row) => validateAndNormalizePledgeRow(row));

type OpenAIParseResult = { rows: ParsedPledge[]; model: string; responseId: string; usage: unknown };

async function parseWithOpenAI(pdfBase64: string, context: { title:string; stockCode:string; stockName:string; announceDate:string }, env: Env): Promise<OpenAIParseResult> {
  if (!env.OPENAI_API_KEY) return {rows:[],model:"",responseId:"",usage:null};
  const model = env.OPENAI_OCR_MODEL || "gpt-5.6-luna";
  const schema = {
    type:"object", additionalProperties:false, required:["events"],
    properties:{events:{type:"array",maxItems:50,items:{
      type:"object", additionalProperties:false,
      required:["shareholder","pledgee","pledge_amount","pledge_ratio","total_ratio","start_date","end_date","purpose","type"],
      properties:{
        shareholder:{type:"string"}, pledgee:{type:"string"}, pledge_amount:{type:"string"},
        pledge_ratio:{type:"string"}, total_ratio:{type:"string"}, start_date:{type:"string"},
        end_date:{type:"string"}, purpose:{type:"string"},
        type:{type:"string",enum:["新增质押","补充质押","解除质押","解除后再质押","质押展期"]},
      },
    }}},
  };
  const prompt = `你是A股股权质押公告的数据审核员。请逐页读取官方公告，只提取公告正文中明确披露的本次质押、补充质押、解除质押记录。\n股票：${context.stockCode} ${context.stockName}\n公告日期：${context.announceDate}\n标题：${context.title}\n要求：1）表格每一行对应一个事件，不合并不同股东、质权人或日期；2）股份数量保留公告原始单位和文本；3）比例、日期、用途没有披露时返回空字符串；4）股东、质权人或数量无法从公告确认时保留空字符串，严禁推测；5）不要把表头、合计行、说明文字识别为主体名称。`;
  const response = await fetchWithRetry("https://api.openai.com/v1/responses", { method:"POST", headers:{ authorization:`Bearer ${env.OPENAI_API_KEY}`, "content-type":"application/json" }, body:JSON.stringify({
    model,
    reasoning:{effort:"low"},
    max_output_tokens:5000,
    input:[{ role:"user", content:[
      { type:"input_file", filename:`${context.stockCode}-${context.announceDate}.pdf`, file_data:`data:application/pdf;base64,${pdfBase64}` },
      { type:"input_text", text:prompt },
    ] }],
    text:{format:{type:"json_schema",name:"a_share_pledge_events",strict:true,schema}},
  }) },1);
  if (!response.ok) {
    const detail = (await response.text()).slice(0,500);
    throw new Error(`OpenAI review failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const payload = await response.json<Record<string, unknown>>();
  const outputText = String(payload.output_text || ((payload.output as Array<{content?:Array<{text?:string}>}> | undefined)?.flatMap((item) => item.content || []).map((item) => item.text || "").join("") || ""));
  if (!outputText.trim()) throw new Error("OpenAI review returned no structured output");
  const jsonText = outputText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return {
    rows:validateParsedRows(normalizeVisionRows(JSON.parse(jsonText),context.title)),
    model:String(payload.model || model),
    responseId:String(payload.id || ""),
    usage:payload.usage || null,
  };
}

async function fingerprint(id: string, row: ParsedPledge, index: number) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([id,row.shareholder,row.pledgee,row.amountText,row.startDate,row.type,index].join("|"))));
}

function eventEvidence(id:string,pages:string[],row:ParsedPledge,method:"rules"|"openai"|"human") {
  const normalize=(value:string)=>String(value||"").replace(/\s+/g,"").toLowerCase();
  const fields=[
    ["shareholder",row.shareholder],
    ["pledgee",row.pledgee],
    ["pledgeAmount",row.amountText],
    ["pledgeRatio",row.pledgeRatio],
    ["totalRatio",row.totalRatio],
  ].filter((entry)=>normalize(String(entry[1])).length>=2) as string[][];
  let bestPage=-1;let bestMatches:string[]=[];
  pages.forEach((page,index)=>{
    const normalizedPage=normalize(page);
    const matches=fields.filter(([,value])=>normalizedPage.includes(normalize(value))).map(([name])=>name);
    if(matches.length>bestMatches.length){bestPage=index;bestMatches=matches;}
  });
  return JSON.stringify({version:"pdf-page-match-v1",method,textKey:`announcements/${id}.txt`,pageNumber:bestPage>=0?bestPage+1:null,matchedFields:bestMatches});
}

async function legacyProcessAnnouncement(db: D1Database, documents: R2Bucket, id: string) {
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
    const response = await fetchWithRetry(item.pdfUrl, { headers: { referer: "https://www.cninfo.com.cn/", "user-agent": "Mozilla/5.0 (compatible; StockEventDB/1.0)" } });
    if (!response.ok) throw new Error(`PDF download failed: ${response.status}`);
    bytes = await response.arrayBuffer();
    sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    r2Key = `announcements/${id}.pdf`;
    await documents.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { announcementId: id, sha256 } });
  }
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const extracted = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  await documents.put(`announcements/${id}.txt`, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  const parsed = parsePledgeText(text, item.title);
  const now = new Date().toISOString();
  if (parsed.missing.length) {
    await db.batch([
      db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='review',last_error=NULL WHERE announcement_id=?").bind(r2Key, sha256, id),
      db.prepare("UPDATE review_queue SET reason=?,payload=? WHERE announcement_id=? AND status='pending'").bind(`自动解析缺少字段：${parsed.missing.join("、")}`, JSON.stringify({ ...parsed, textKey: `announcements/${id}.txt` }), id),
      db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement", id, "parse_review", JSON.stringify({ missing: parsed.missing, parserVersion: "unpdf-rules-v1" }), "worker", now),
    ]);
    return { id, status: "review", missing: parsed.missing };
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.stockCode,item.stockName,parsed.shareholder,parsed.pledgee,parsed.amount,parsed.amountText,parsed.pledgeRatio||null,parsed.totalRatio||null,parsed.startDate||null,parsed.endDate||null,parsed.purpose||null,parsed.type,item.announceDate,0.82,"unpdf-rules-v1",now),
    db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='parsed',last_error=NULL WHERE announcement_id=?").bind(r2Key, sha256, id),
    db.prepare("UPDATE review_queue SET status='approved',reason='自动解析字段完整',reviewed_at=?,reviewer='worker',resolution=? WHERE announcement_id=? AND status='pending'").bind(now,JSON.stringify(parsed),id),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("pledge",id,"auto_parse",JSON.stringify({ ...parsed, parserVersion: "unpdf-rules-v1" }),"worker",now),
  ]);
  return { id, status: "parsed", event: parsed };
}

async function processAnnouncement(db: D1Database, documents: R2Bucket, id: string, env?: Env, options: {forceOpenAI?:boolean} = {}) {
  const item = await db.prepare("SELECT announcement_id AS id,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,r2_key AS r2Key,sha256,parse_attempts AS parseAttempts FROM announcement WHERE announcement_id=?").bind(id).first<{id:string;stockCode:string;stockName:string;title:string;announceDate:string;pdfUrl:string;r2Key?:string;sha256?:string;parseAttempts:number}>();
  if (!item) throw new Error("announcement not found");
  let bytes: ArrayBuffer; let r2Key = item.r2Key; let sha256 = item.sha256;
  if (r2Key) { const object = await documents.get(r2Key); if (!object) throw new Error("archived PDF not found"); bytes = await object.arrayBuffer(); }
  else {
    const response = await fetchWithRetry(item.pdfUrl,{headers:{referer:"https://www.cninfo.com.cn/","user-agent":"Mozilla/5.0 (compatible; StockEventDB/1.0)"}},1);
    if (!response.ok) throw new Error(`PDF download failed: ${response.status}`);
    bytes = await response.arrayBuffer(); sha256 = hex(await crypto.subtle.digest("SHA-256",bytes)); r2Key = `announcements/${id}.pdf`;
    await documents.put(r2Key,bytes,{httpMetadata:{contentType:"application/pdf"},customMetadata:{announcementId:id,sha256}});
  }
  // PDF.js may transfer/detach the supplied buffer. Parse a copy so the
  // archived bytes remain available for the OpenAI fallback below.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0))); const extracted = await extractText(pdf,{mergePages:false});
  const pages = Array.isArray(extracted.text) ? extracted.text.map((page)=>String(page)) : [String(extracted.text||"")];
  const text = pages.join("\n\f\n");
  await documents.put(`announcements/${id}.txt`,text,{httpMetadata:{contentType:"text/plain; charset=utf-8"}});
  let rows = validateParsedRows(parsePledgeRows(text,item.title)); let parserVersion = "unpdf-table-rules-v2.4"; let confidence = rows.length > 1 ? 0.9 : 0.86;
  const localIncomplete = !rows.length || rows.some((row) => row.missing.length > 0);
  let openaiMeta: {model:string;responseId:string;usage:unknown} | null = null;
  let openaiError = "";
  const quotaState = localIncomplete && env?.OPENAI_API_KEY && options.forceOpenAI !== true
    ? await db.prepare("SELECT value FROM pipeline_state WHERE key='openai_quota_blocked_until'").first<{value:string}>()
    : null;
  const quotaBlocked = Boolean(quotaState?.value && Date.parse(quotaState.value) > Date.now());
  const openaiAllowed = Boolean(env?.OPENAI_API_KEY) && !quotaBlocked && ((item.parseAttempts || 0) < 2 || options.forceOpenAI === true);
  let openaiAttempted = false;
  if (localIncomplete && openaiAllowed && env) {
    openaiAttempted = true;
    try {
      const reviewed = await parseWithOpenAI(arrayBufferToBase64(bytes),{title:item.title,stockCode:item.stockCode,stockName:item.stockName,announceDate:item.announceDate},env);
      if (reviewed.rows.length) {
        rows = reviewed.rows;
        parserVersion = `openai-${reviewed.model}-pledge-v1`;
        confidence = 0.94;
        openaiMeta = {model:reviewed.model,responseId:reviewed.responseId,usage:reviewed.usage};
      }
    } catch (error) {
      openaiError = error instanceof Error ? error.message : "OpenAI review failed";
      if (/credit_balance_exhausted|insufficient_quota|no credits remaining/i.test(openaiError)) {
        const blockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await db.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('openai_quota_blocked_until',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(blockedUntil,new Date().toISOString()).run();
      }
    }
  }
  const completeRows = rows.filter((row) => !row.missing.length); const parsed = rows[0]; const now = new Date().toISOString();
  const verificationStatus = openaiMeta ? "ai_reviewed" : "rules_validated";
  const verifiedAt = openaiMeta ? now : null;
  const verifiedBy = openaiMeta ? "openai" : "rules-engine";
  const evidenceMethod = openaiMeta ? "openai" : "rules";
  if (!completeRows.length || rows.some((row) => row.missing.length > 0)) {
    const missing = parsed?.missing || ["股东","质权人","质押数量"];
    const reviewReason = openaiAttempted
      ? `OpenAI 自动复核后仍缺少字段：${missing.join("、")}${openaiError ? `；${openaiError.slice(0,180)}` : ""}`
      : quotaBlocked
        ? `OpenAI 额度暂不可用，已暂停自动调用；仍缺少字段：${missing.join("、")}`
        : env?.OPENAI_API_KEY
        ? `自动复核已达到重试上限；仍缺少字段：${missing.join("、")}，请人工审核`
        : `本地规则解析缺少字段：${missing.join("、")}；OpenAI 未配置，请人工审核`;
    const reviewStatements: D1PreparedStatement[] = [];
    for (let index = 0; index < completeRows.length; index++) {
      const row = completeRows[index]; const eventFingerprint = await fingerprint(id,row,index);
      reviewStatements.push(db.prepare("INSERT OR IGNORE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at,event_fingerprint,verification_status,verified_at,verified_by,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.stockCode,item.stockName,row.shareholder,row.pledgee,row.amount,row.amountText,row.pledgeRatio||null,row.totalRatio||null,row.startDate||null,row.endDate||null,row.purpose||null,row.type,item.announceDate,confidence,parserVersion,now,eventFingerprint,verificationStatus,verifiedAt,verifiedBy,eventEvidence(id,pages,row,evidenceMethod)));
    }
    reviewStatements.push(
      db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='review',last_error=?,parse_attempts=parse_attempts+? WHERE announcement_id=?").bind(r2Key,sha256,openaiError || null,openaiAttempted ? 1 : 0,id),
      db.prepare("UPDATE review_queue SET reason=?,payload=?,reviewed_at=?,reviewer=? WHERE announcement_id=? AND status='pending'").bind(reviewReason,JSON.stringify({...parsed,candidates:rows,textKey:`announcements/${id}.txt`,openaiConfigured:Boolean(env?.OPENAI_API_KEY),openaiAttempted,openaiMeta,openaiError:openaiError || null}),now,openaiMeta ? "openai" : "worker",id),
      db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",id,"parse_review",JSON.stringify({missing,confirmedEvents:completeRows.length,parserVersion,openaiConfigured:Boolean(env?.OPENAI_API_KEY),openaiAttempted,openaiMeta,openaiError:openaiError || null}),openaiMeta ? "openai" : "worker",now),
    );
    await db.batch(reviewStatements);
    return {id,status:"review",missing,events_created:completeRows.length,openai_attempted:openaiAttempted,openai_error:openaiError || undefined};
  }
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < completeRows.length; index++) {
    const row = completeRows[index]; const eventFingerprint = await fingerprint(id,row,index);
    statements.push(db.prepare("INSERT OR IGNORE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at,event_fingerprint,verification_status,verified_at,verified_by,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.stockCode,item.stockName,row.shareholder,row.pledgee,row.amount,row.amountText,row.pledgeRatio||null,row.totalRatio||null,row.startDate||null,row.endDate||null,row.purpose||null,row.type,item.announceDate,confidence,parserVersion,now,eventFingerprint,verificationStatus,verifiedAt,verifiedBy,eventEvidence(id,pages,row,evidenceMethod)));
  }
  statements.push(
    db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='parsed',last_error=NULL,parse_attempts=0 WHERE announcement_id=?").bind(r2Key,sha256,id),
    db.prepare("UPDATE review_queue SET status='approved',reason=?,reviewed_at=?,reviewer=?,resolution=? WHERE announcement_id=? AND status='pending'").bind(openaiMeta ? "OpenAI 自动复核通过" : "本地规则解析字段完整",now,openaiMeta ? "openai" : "worker",JSON.stringify({events:completeRows,parserVersion,openaiMeta}),id),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("pledge",id,openaiMeta ? "openai_review" : "auto_parse",JSON.stringify({events:completeRows,eventCount:completeRows.length,parserVersion,openaiMeta}),openaiMeta ? "openai" : "worker",now),
  );
  await db.batch(statements);
  return {id,status:"parsed",events:completeRows,event_count:completeRows.length,parser_version:parserVersion};
}

async function processPendingQueue(db: D1Database, documents: R2Bucket, requestedLimit = 3, env?: Env, priorityDate?: string) {
  const limit = Math.min(Math.max(requestedLimit, 1), 10);
  const startedAt = new Date().toISOString();
  const run = await db.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("pdf-parser",startedAt,"running",`开始处理最多 ${limit} 条公告`).first<{id:number}>();
  const pending = priorityDate
    ? await db.prepare("SELECT announcement_id AS id FROM announcement WHERE parse_status IN ('queued','archived') AND announce_date=? ORDER BY announcement_id LIMIT ?").bind(priorityDate,limit).all<{id:string}>()
    : await db.prepare("SELECT announcement_id AS id FROM announcement WHERE parse_status IN ('queued','archived') ORDER BY announce_date DESC LIMIT ?").bind(limit).all<{id:string}>();
  const claimedAt=new Date().toISOString();
  if(pending.results.length)await db.batch(pending.results.flatMap((row)=>[
    db.prepare("UPDATE announcement SET parse_status='processing',parse_attempts=parse_attempts+1,last_error=NULL WHERE announcement_id=? AND parse_status IN ('queued','archived')").bind(row.id),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",row.id,"parse_claim",JSON.stringify({runId:run?.id,priorityDate:priorityDate||null}),"pdf-worker",claimedAt),
  ]));
  const results: unknown[] = []; let parsed = 0; let failures = 0;
  for (const row of pending.results) {
    try { const result = await withDeadline(processAnnouncement(db,documents,row.id,env),25_000,`announcement ${row.id}`); results.push(result); parsed += result.event_count || result.events_created || 0; }
    catch (error) {
      failures++; const message = error instanceof Error ? error.message : "parse failed";
      await db.prepare("UPDATE announcement SET parse_status='queued',last_error=? WHERE announcement_id=?").bind(message,row.id).run();
      const attempt = await db.prepare("SELECT parse_attempts AS attempts FROM announcement WHERE announcement_id=?").bind(row.id).first<{attempts:number}>();
      if ((attempt?.attempts || 0) >= 3) {
        await db.batch([
          db.prepare("UPDATE announcement SET parse_status='review' WHERE announcement_id=?").bind(row.id),
          db.prepare("UPDATE review_queue SET reason=?,payload=json_set(payload,'$.lastError',?,'$.parseAttempts',?) WHERE announcement_id=? AND status='pending'").bind(`自动处理连续失败 ${(attempt?.attempts || 0)} 次`,message,attempt?.attempts || 0,row.id),
        ]);
      }
      results.push({ id:row.id,status:"failed",attempts:attempt?.attempts || 0,error:message });
    }
  }
  await db.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,failures=?,message=? WHERE id=?").bind(new Date().toISOString(),failures ? "completed_with_errors" : "completed",results.length,parsed,failures,`处理 ${results.length} 条，生成 ${parsed} 条事件，失败 ${failures} 条`,run?.id).run();
  return { run_id:run?.id,processed:results.length,events_created:parsed,failures,results };
}

async function backfillAnnouncementEvidence(db:D1Database,documents:R2Bucket,id:string) {
  const announcement=await db.prepare("SELECT announcement_id AS id,pdf_url AS pdfUrl,r2_key AS r2Key,sha256 FROM announcement WHERE announcement_id=?").bind(id).first<{id:string;pdfUrl:string;r2Key?:string;sha256?:string}>();
  if(!announcement)throw new Error("announcement not found");
  let bytes:ArrayBuffer;
  if(announcement.r2Key){const object=await documents.get(announcement.r2Key);if(!object)throw new Error("archived PDF not found");bytes=await object.arrayBuffer();}
  else{const response=await fetchWithRetry(announcement.pdfUrl,{headers:{referer:"https://www.cninfo.com.cn/","user-agent":"Mozilla/5.0 (compatible; PledgeRadar/1.0; evidence-backfill)"}});if(!response.ok)throw new Error(`PDF download failed: ${response.status}`);bytes=await response.arrayBuffer();const signature=new TextDecoder("ascii").decode(new Uint8Array(bytes.slice(0,4)));if(signature!=="%PDF")throw new Error("official document is not a PDF");const sha256=hex(await crypto.subtle.digest("SHA-256",bytes));const r2Key=`announcements/${id}.pdf`;await documents.put(r2Key,bytes,{httpMetadata:{contentType:"application/pdf"},customMetadata:{announcementId:id,sha256}});await db.prepare("UPDATE announcement SET r2_key=?,sha256=? WHERE announcement_id=?").bind(r2Key,sha256,id).run();}
  const pdf=await getDocumentProxy(new Uint8Array(bytes.slice(0)));const extracted=await extractText(pdf,{mergePages:false});
  const pages=Array.isArray(extracted.text)?extracted.text.map((page)=>String(page)):[String(extracted.text||"")];
  await documents.put(`announcements/${id}.txt`,pages.join("\n\f\n"),{httpMetadata:{contentType:"text/plain; charset=utf-8"}});
  const events=await db.prepare("SELECT id,shareholder,pledgee,pledge_amount AS amount,pledge_amount_text AS amountText,pledge_ratio AS pledgeRatio,total_ratio AS totalRatio,start_date AS startDate,end_date AS endDate,purpose,type FROM pledge WHERE announcement_id=? ORDER BY id").bind(id).all<ParsedPledge&{id:number}>();
  let located=0;const statements:D1PreparedStatement[]=[];
  for(const row of events.results){const evidence=eventEvidence(id,pages,row,"pdf-evidence-backfill");const parsed=JSON.parse(evidence) as {pageNumber?:number|null};if(parsed.pageNumber)located++;statements.push(db.prepare("UPDATE pledge SET evidence_json=? WHERE id=?").bind(evidence,row.id));}
  const now=new Date().toISOString();statements.push(db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",id,"evidence_backfill_attempt",JSON.stringify({events:events.results.length,located,pages:pages.length}),"evidence-worker",now));
  if(statements.length)await db.batch(statements);
  return {id,events:events.results.length,located,pages:pages.length};
}

async function runEvidenceBackfill(env:Env,requestedLimit=5) {
  const limit=Math.min(Math.max(requestedLimit,1),10);const startedAt=new Date().toISOString();
  const run=await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("evidence-backfill",startedAt,"running",`补齐最多 ${limit} 份公告的PDF页码证据`).first<{id:number}>();
  const candidates=await env.DB.prepare("SELECT a.announcement_id AS id FROM announcement a JOIN pledge p ON p.announcement_id=a.announcement_id WHERE json_extract(p.evidence_json,'$.pageNumber') IS NULL AND (SELECT COUNT(*) FROM audit_log l WHERE l.entity_type='announcement' AND l.entity_id=a.announcement_id AND l.action='evidence_backfill_attempt')<2 GROUP BY a.announcement_id ORDER BY MIN(CASE WHEN p.type='补充质押' THEN 0 ELSE 1 END),a.announce_date DESC LIMIT ?").bind(limit).all<{id:string}>();
  const results:unknown[]=[];let located=0;let failures=0;
  for(const row of candidates.results){try{const result=await backfillAnnouncementEvidence(env.DB,env.DOCUMENTS,row.id);located+=result.located;results.push(result);}catch(error){failures++;const message=error instanceof Error?error.message:"evidence backfill failed";const now=new Date().toISOString();await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",row.id,"evidence_backfill_attempt",JSON.stringify({error:message}),"evidence-worker",now).run();results.push({id:row.id,error:message});}}
  const finishedAt=new Date().toISOString();await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,failures=?,message=? WHERE id=?").bind(finishedAt,failures?"completed_with_errors":"completed",candidates.results.length,located,failures,`处理 ${candidates.results.length} 份公告，定位 ${located} 条事件，失败 ${failures} 份`,run?.id).run();
  return {runId:run?.id,processed:candidates.results.length,located,failures,results,finishedAt};
}

async function runParserUpgradeRetry(env:Env,requestedLimit=3) {
  const limit=Math.min(Math.max(requestedLimit,1),5);const startedAt=new Date().toISOString();
  const run=await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("parser-upgrade-retry",startedAt,"running",`使用规则解析器v2.4重试最多 ${limit} 份待审核公告`).first<{id:number}>();
  const candidates=await env.DB.prepare("SELECT a.announcement_id AS id FROM announcement a JOIN review_queue r ON r.announcement_id=a.announcement_id AND r.status='pending' WHERE a.parse_status='review' AND a.parse_attempts<2 AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type='announcement' AND l.entity_id=a.announcement_id AND l.action='parser_upgrade_v2_4_attempt') GROUP BY a.announcement_id ORDER BY a.announce_date DESC LIMIT ?").bind(limit).all<{id:string}>();
  const results:unknown[]=[];let eventsCreated=0;let unresolved=0;let failures=0;
  for(const row of candidates.results){try{const result=await processAnnouncement(env.DB,env.DOCUMENTS,row.id,env);eventsCreated+=result.event_count||result.events_created||0;if(result.status!=="parsed")unresolved++;results.push(result);await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",row.id,"parser_upgrade_v2_4_attempt",JSON.stringify(result),"parser-upgrade-worker",new Date().toISOString()).run();}catch(error){failures++;const message=error instanceof Error?error.message:"parser upgrade retry failed";await env.DB.batch([env.DB.prepare("UPDATE announcement SET parse_attempts=parse_attempts+1,last_error=? WHERE announcement_id=?").bind(message,row.id),env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",row.id,"parser_upgrade_v2_4_attempt",JSON.stringify({error:message}),"parser-upgrade-worker",new Date().toISOString())]);results.push({id:row.id,status:"failed",error:message});}}
  const finishedAt=new Date().toISOString();await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,failures=?,message=? WHERE id=?").bind(finishedAt,failures||unresolved?"completed_with_errors":"completed",candidates.results.length,eventsCreated,failures,`重试 ${candidates.results.length} 份，生成 ${eventsCreated} 条事件，仍待审核 ${unresolved} 份，失败 ${failures} 份`,run?.id).run();
  return {runId:run?.id,processed:candidates.results.length,eventsCreated,unresolved,failures,results,finishedAt};
}

async function runHistoricalBackfillBatch(env:Env,requestedTradingDays=1) {
  const tradingDays=Math.min(Math.max(requestedTradingDays,1),7);
  const [state,earliest,lastHistoricalRun]=await Promise.all([
    env.DB.prepare("SELECT value FROM pipeline_state WHERE key='historical_backfill_cursor'").first<{value:string}>(),
    env.DB.prepare("SELECT MIN(announce_date) AS date FROM announcement").first<{date:string}>(),
    env.DB.prepare("SELECT status,failures,announcements_found AS found FROM sync_run WHERE source='historical-rolling-backfill' ORDER BY id DESC LIMIT 1").first<{status:string;failures:number;found:number}>(),
  ]);
  let cursor=state?.value||earliest?.date||shanghaiDate();if(earliest?.date&&cursor<earliest.date&&lastHistoricalRun?.failures&&!lastHistoricalRun.found)cursor=earliest.date;
  const dates:string[]=[];let candidate=addDays(cursor,-1);while(dates.length<tradingDays){if(isTradingDate(candidate))dates.push(candidate);candidate=addDays(candidate,-1);}
  const startedAt=new Date().toISOString();const run=await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("historical-rolling-backfill",startedAt,"running",`滚动回补 ${dates[dates.length-1]} 至 ${dates[0]}`).first<{id:number}>();
  let found=0;let inserted=0;let failures=0;let sourceWarnings=0;const results:{date:string;found:number;inserted:number;warnings?:string[];error?:string}[]=[];
  for(const date of [...dates].reverse()){try{const result=await ingestCninfo(env.DB,date);found+=result.found;inserted+=result.inserted;sourceWarnings+=result.warnings.length;results.push({date,...result});}catch(error){failures++;results.push({date,found:0,inserted:0,error:error instanceof Error?error.message:"sync failed"});}}
  const nextCursor=failures?cursor:dates[dates.length-1];const finishedAt=new Date().toISOString();const firstError=results.find((result)=>result.error)?.error;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('historical_backfill_cursor',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(nextCursor,finishedAt),
    env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,failures=?,message=? WHERE id=?").bind(finishedAt,failures||sourceWarnings?"completed_with_errors":"completed",found,failures,`滚动回补 ${dates.length} 个交易日：发现 ${found} 条，新增 ${inserted} 条，失败 ${failures} 日，来源警告 ${sourceWarnings} 条${firstError?`；${firstError.slice(0,180)}`:""}`,run?.id),
  ]);
  return {ok:!failures,run_id:run?.id,dates:results,found,inserted,failures,sourceWarnings,cursor:nextCursor,firstError:firstError||null};
}

async function runMaintenanceCycle(env:Env,reason:string) {
  const startedAt=new Date().toISOString();
  try{const parserRetry=await runParserUpgradeRetry(env,3);const evidence=await runEvidenceBackfill(env,5);const history=await runHistoricalBackfillBatch(env,1);const processing=history.inserted?await processPendingQueue(env.DB,env.DOCUMENTS,5,env):null;const result={reason,parserRetry,evidence,history,processing,startedAt,finishedAt:new Date().toISOString()};await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('data_maintenance_last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(result),result.finishedAt).run();return result;}
  catch(error){const result={reason,status:"failed",message:error instanceof Error?error.message:"maintenance failed",startedAt,finishedAt:new Date().toISOString()};await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('data_maintenance_last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(result),result.finishedAt).run();throw error;}
}

async function fetchCninfo(date: string) {
  const all: CninfoAnnouncement[] = [];
  const warnings: string[] = [];
  let successfulQueries = 0;
  // “质押” is the inclusive full-text term for新增、补充、解除和展期。
  // Repeating five overlapping terms multiplied the same result set and could
  // leave a Worker waiting on 15-150 upstream requests before parsing began.
  const keywords = ["质押"];
  for (const column of ["szse", "sse", "bjse"]) {
    keywordLoop: for (const searchkey of keywords) {
      for (let pageNum = 1; pageNum <= 10; pageNum++) {
        const body = new URLSearchParams({ pageNum: String(pageNum), pageSize: "100", column, tabName: "fulltext", plate: "", stock: "", searchkey, secid: "", category: "", trade: "", seDate: `${date}~${date}`, sortName: "", sortType: "", isHLtitle: "true" });
        const response = await fetchWithRetry("https://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json, text/plain, */*", referer: "https://www.cninfo.com.cn/new/disclosure", "user-agent": "Mozilla/5.0 (compatible; StockEventDB/1.0; public-disclosure-research)" }, body });
        if (!response.ok) {
          warnings.push(`巨潮资讯 ${column}/${searchkey} 返回 ${response.status}`);
          if (pageNum === 1) continue keywordLoop;
          break;
        }
        successfulQueries++;
        const data = await response.json<CninfoResult>();
        const rows = data.announcements || [];
        all.push(...rows);
        if (rows.length < 100 || rows.length === 0) break;
      }
    }
  }
  if (!successfulQueries) throw new Error(warnings[0] || "巨潮资讯所有市场查询均失败");
  return {items:[...new Map(all.map((item) => [item.announcementId, item])).values()],warnings};
}

async function ingestCninfo(db: D1Database, date: string) {
  const fetched = await fetchCninfo(date); const announcements = fetched.items.filter((item) => isRelevantSharePledgeTitle(stripHtml(item.announcementTitle))); const now = new Date().toISOString(); let inserted = 0;
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
  return { found: announcements.length, inserted, warnings:fetched.warnings };
}

type ExchangeObservationInput = { source:string;sourceAnnouncementId:string;stockCode:string;stockName:string;title:string;announceDate:string;pdfUrl:string|null;raw:unknown };
const parseJsonp = (text:string) => { const start=text.indexOf("("); const end=text.lastIndexOf(")"); if(start<0||end<=start) throw new Error("invalid JSONP response"); return JSON.parse(text.slice(start+1,end)); };
const normalizeAnnouncementTitle = (title:string,stockName="") => stripHtml(title).replace(stockName,"").replace(/^\[?临时公告\]?/g,"").replace(/[\s：:，,。；;（）()【】\[\]《》“”"'·\-—_]/g,"").toLowerCase();
const titleFingerprint = async (title:string,stockName:string) => hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(normalizeAnnouncementTitle(title,stockName))));

async function fetchSseObservations(date:string):Promise<ExchangeObservationInput[]> {
  const collected:Record<string,unknown>[]=[];let pageCount=1;
  for(let pageNo=1;pageNo<=Math.min(pageCount,30);pageNo++){
    const params=new URLSearchParams({isPagination:"true","pageHelp.pageSize":"100","pageHelp.pageNo":String(pageNo),"pageHelp.beginPage":String(pageNo),"pageHelp.endPage":String(pageNo),"pageHelp.cacheSize":"1",START_DATE:date,END_DATE:date,SECURITY_CODE:"",TITLE:"",BULLETIN_TYPE:"",stockType:"",jsonCallBack:"callback"});
    const response=await fetchWithRetry(`https://query.sse.com.cn/security/stock/queryCompanyBulletinNew.do?${params}`,{headers:{referer:"https://www.sse.com.cn/disclosure/listedinfo/announcement/","user-agent":"Mozilla/5.0 (compatible; PledgeRadar/1.0)"}},2);
    if(!response.ok) throw new Error(`SSE HTTP ${response.status}`);
    const payload=parseJsonp(await response.text()) as {pageHelp?:{data?:unknown[];pageCount?:number};result?:unknown[]};
    pageCount=Math.max(1,Number(payload.pageHelp?.pageCount||1));
    const raw=payload.pageHelp?.data||payload.result||[];
    collected.push(...raw.flatMap((item)=>Array.isArray(item)?item:[item]).filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==="object"));
  }
  const rows=[...new Map(collected.map((row)=>[String(row.ORG_BULLETIN_ID||row.URL||""),row])).values()];
  return rows.filter((row)=>String(row.SSEDATE||date).slice(0,10)===date&&isRelevantSharePledgeTitle(String(row.TITLE||""))).map((row)=>({source:"上交所",sourceAnnouncementId:String(row.ORG_BULLETIN_ID||row.URL||""),stockCode:String(row.SECURITY_CODE||""),stockName:String(row.SECURITY_NAME||""),title:String(row.TITLE||""),announceDate:String(row.SSEDATE||date).slice(0,10),pdfUrl:row.URL?new URL(String(row.URL),"https://www.sse.com.cn").toString():null,raw:row})).filter((row)=>row.sourceAnnouncementId&&row.stockCode&&row.title);
}

async function fetchSzseObservations(date:string):Promise<{rows:ExchangeObservationInput[];supportedRange:string[]}> {
  const collected:Record<string,unknown>[]=[]; let supportedRange:string[]=[];
  for(let pageNum=1;pageNum<=12;pageNum++){
    const params=new URLSearchParams({plateCode:"szse",pageSize:"50",pageNum:String(pageNum)});
    const response=await fetchWithRetry(`https://www.szse.cn/api/disc/announcement/detailinfo?${params}`,{headers:{referer:"https://www.szse.cn/disclosure/listed/notice/index.html","user-agent":"Mozilla/5.0 (compatible; PledgeRadar/1.0)"}},2);
    if(!response.ok) throw new Error(`SZSE HTTP ${response.status}`);
    const payload=await response.json() as {defaultValue?:string[];data?:{secCode?:string;secName?:string;announList?:Record<string,unknown>[]}[]};
    if(pageNum===1) supportedRange=payload.defaultValue||[];
    const groups=payload.data||[]; if(!groups.length) break;
    for(const group of groups) for(const announcement of group.announList||[]) collected.push({...announcement,secCode:group.secCode,secName:group.secName});
    if(groups.length<50) break;
  }
  if(supportedRange.length===2&&(date<supportedRange[0]||date>supportedRange[1])) return {rows:[],supportedRange};
  const rows=collected.filter((row)=>String(row.publishTime||"").slice(0,10)===date&&isRelevantSharePledgeTitle(String(row.title||""))).map((row)=>({source:"深交所",sourceAnnouncementId:String(row.id||row.annId||row.attachPath||""),stockCode:String(row.secCode||""),stockName:String(row.secName||""),title:String(row.title||""),announceDate:String(row.publishTime||date).slice(0,10),pdfUrl:row.attachPath?new URL(String(row.attachPath),"https://disc.static.szse.cn").toString():null,raw:row})).filter((row)=>row.sourceAnnouncementId&&row.stockCode&&row.title);
  return {rows,supportedRange};
}

async function fetchBseObservations(date:string):Promise<ExchangeObservationInput[]> {
  const needFields=["companyCd","companyName","disclosureTitle","disclosurePostTitle","destFilePath","publishDate","xxfcbj","fileExt","xxzrlx"];
  const rows:Record<string,unknown>[]=[];let totalPages=1;
  for(let page=0;page<Math.min(totalPages,20);page++){
    const form=new URLSearchParams({siteId:"6",flag:"0",page:String(page),companyCd:"",isNewThree:"1",startTime:date,endTime:date,keyword:"质押",sortfield:"xxssdq",sorttype:"desc"});
    form.append("noticeType[]","5");form.append("disclosureType[]","5");form.append("disclosureSubtype[]","");form.append("xxfcbj[]","2");form.append("hyType[]","");
    for(const field of needFields) form.append("needFields[]",field);
    const response=await fetchWithRetry("https://www.bse.cn/disclosureInfoController/initDisclosureList.do?callback=callback",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded; charset=UTF-8",accept:"text/javascript, application/javascript, application/json, */*; q=0.01",origin:"https://www.bse.cn",referer:"https://www.bse.cn/disclosure/announcement.html","x-requested-with":"XMLHttpRequest","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"},body:form.toString()},2);
    if(!response.ok) throw new Error(`BSE HTTP ${response.status}`);
    const payload=parseJsonp(await response.text()) as {data?:{content?:{disclosures?:Record<string,unknown>[]}[];lastPage?:boolean;totalPages?:number}};
    for(const group of payload.data?.content||[]) rows.push(...(group.disclosures||[]));
    totalPages=Math.max(1,Number(payload.data?.totalPages||1));
    if(payload.data?.lastPage||page+1>=totalPages) break;
    await wait(120);
  }
  return [...new Map(rows.map((row)=>[String(row.disclosureCode||row.destFilePath||""),row])).values()].filter((row)=>String(row.publishDate||"")===date&&isRelevantSharePledgeTitle(String(row.disclosureTitle||"")+String(row.disclosurePostTitle||""))).map((row)=>({source:"北交所",sourceAnnouncementId:String(row.disclosureCode||row.destFilePath||""),stockCode:String(row.companyCd||""),stockName:String(row.companyName||""),title:`${String(row.disclosureTitle||"")}${String(row.disclosurePostTitle||"")}`,announceDate:String(row.publishDate||date),pdfUrl:row.destFilePath?new URL(String(row.destFilePath),"https://www.bse.cn").toString():null,raw:row})).filter((row)=>row.sourceAnnouncementId&&row.stockCode&&row.title);
}

async function saveExchangeObservations(db:D1Database,rows:ExchangeObservationInput[]) {
  const now=new Date().toISOString(); let exact=0;let likely=0;let missing=0;let ambiguous=0;
  for(const row of rows){
    const fingerprint=await titleFingerprint(row.title,row.stockName);
    const candidates=await db.prepare("SELECT announcement_id AS announcementId,title,stock_name AS stockName FROM announcement WHERE stock_code=? AND announce_date=?").bind(row.stockCode,row.announceDate).all<{announcementId:string;title:string;stockName:string}>();
    const normalized=normalizeAnnouncementTitle(row.title,row.stockName);
    const exactMatch=candidates.results.find((candidate)=>normalizeAnnouncementTitle(candidate.title,candidate.stockName)===normalized);
    const relevant=candidates.results.filter((candidate)=>isRelevantSharePledgeTitle(candidate.title));
    const matched=exactMatch||relevant.length===1?exactMatch||relevant[0]:null;
    const matchStatus=exactMatch?"exact":matched?"likely":relevant.length?"ambiguous":"missing_primary";
    const matchMethod=exactMatch?"stock-date-normalized-title":matched?"single-pledge-candidate-same-stock-date":relevant.length?"multiple-pledge-candidates-same-stock-date":"no-primary-candidate";
    if(matchStatus==="exact")exact++;else if(matchStatus==="likely")likely++;else if(matchStatus==="ambiguous")ambiguous++;else missing++;
    await db.prepare("INSERT INTO exchange_observation (source,source_announcement_id,stock_code,stock_name,title,announce_date,pdf_url,title_fingerprint,match_status,match_method,matched_announcement_id,raw_json,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_announcement_id) DO UPDATE SET stock_code=excluded.stock_code,stock_name=excluded.stock_name,title=excluded.title,announce_date=excluded.announce_date,pdf_url=excluded.pdf_url,title_fingerprint=excluded.title_fingerprint,match_status=excluded.match_status,match_method=excluded.match_method,matched_announcement_id=excluded.matched_announcement_id,raw_json=excluded.raw_json,observed_at=excluded.observed_at").bind(row.source,row.sourceAnnouncementId,row.stockCode,row.stockName,row.title,row.announceDate,row.pdfUrl,fingerprint,matchStatus,matchMethod,matched?.announcementId||null,JSON.stringify(row.raw),now).run();
    if(matchStatus==="likely"&&matched?.announcementId)await db.prepare("UPDATE exchange_observation SET review_status='linked',reviewed_at=?,reviewed_by='deterministic-reconciliation',review_note='同股票同日期只有一个质押公告候选，自动关联主库' WHERE source=? AND source_announcement_id=? AND review_status='pending'").bind(now,row.source,row.sourceAnnouncementId).run();
  }
  return {observed:rows.length,exact,likely,ambiguous,missing};
}

async function runExchangeReconciliation(db:D1Database,date:string,sources:string[]) {
  const startedAt=new Date().toISOString();
  const run=await db.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("exchange-reconciliation",startedAt,"running",`交易所对账 ${date}`).first<{id:number}>();
  const results:Record<string,unknown>[]=[];let found=0;let failures=0;
  for(const source of sources){
    try{
      if(source==="sse"){const rows=await fetchSseObservations(date);const summary=await saveExchangeObservations(db,rows);found+=rows.length;results.push({source:"上交所",status:"completed",...summary});}
      else if(source==="szse"){const fetched=await fetchSzseObservations(date);if(fetched.supportedRange.length===2&&(date<fetched.supportedRange[0]||date>fetched.supportedRange[1])){results.push({source:"深交所",status:"unsupported_date",supportedRange:fetched.supportedRange,note:"公开接口仅提供最近披露窗口"});continue;}const summary=await saveExchangeObservations(db,fetched.rows);found+=fetched.rows.length;results.push({source:"深交所",status:"completed",supportedRange:fetched.supportedRange,...summary});}
      else if(source==="bse"){const rows=await fetchBseObservations(date);const summary=await saveExchangeObservations(db,rows);found+=rows.length;results.push({source:"北交所",status:"completed",...summary});}
    }catch(error){failures++;results.push({source,status:"failed",error:error instanceof Error?error.message:"reconciliation failed"});}
  }
  const finishedAt=new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,failures=?,message=? WHERE id=?").bind(finishedAt,failures?"completed_with_errors":"completed",found,failures,JSON.stringify({date,results}),run?.id),
    db.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('exchange_reconciliation_last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify({date,results,runId:run?.id}),finishedAt),
  ]);
  return {runId:run?.id,date,found,failures,results};
}

type ExchangeObservationRow = {
  id:number;source:string;sourceAnnouncementId:string;stockCode:string;stockName:string;title:string;
  announceDate:string;pdfUrl:string|null;titleFingerprint:string;matchStatus:string;reviewStatus:string;
  matchedAnnouncementId:string|null;
};
type PromotionResult={status:"promoted"|"linked";announcementId:string;idempotent?:boolean;r2Key?:string;sha256?:string;size?:number};

const officialPdfHosts:Record<string,Set<string>> = {
  "上交所": new Set(["www.sse.com.cn","static.sse.com.cn"]),
  "深交所": new Set(["disc.static.szse.cn","www.szse.cn"]),
  "北交所": new Set(["www.bse.cn"]),
};

function validatedOfficialPdfUrl(source:string,value:string|null) {
  if(!value) throw new Error("该观察记录缺少交易所 PDF 地址");
  const url=new URL(value);
  const allowed=officialPdfHosts[source];
  if(url.protocol!=="https:"||!allowed?.has(url.hostname)||!/\.pdf$/i.test(url.pathname)) throw new Error("PDF 地址未通过官方域名校验");
  return url;
}

function exchangeDownloadHeaders(source:string) {
  const referer=source==="上交所"?"https://www.sse.com.cn/disclosure/listedinfo/announcement/":source==="深交所"?"https://www.szse.cn/disclosure/listed/notice/index.html":"https://www.bse.cn/disclosure/announcement.html";
  return {referer,"user-agent":"Mozilla/5.0 (compatible; PledgeRadar/1.0; official-disclosure-archive)"};
}

async function promoteExchangeObservation(db:D1Database,documents:R2Bucket,id:number,viewer:string):Promise<PromotionResult> {
  const row=await db.prepare("SELECT id,source,source_announcement_id AS sourceAnnouncementId,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,title_fingerprint AS titleFingerprint,match_status AS matchStatus,review_status AS reviewStatus,matched_announcement_id AS matchedAnnouncementId FROM exchange_observation WHERE id=?").bind(id).first<ExchangeObservationRow>();
  if(!row) throw new Error("观察记录不存在");
  if(row.reviewStatus==="promoted"&&row.matchedAnnouncementId) return {status:"promoted",announcementId:row.matchedAnnouncementId,idempotent:true};
  if(row.reviewStatus!=="pending"||row.matchStatus!=="missing_primary") throw new Error("只有待确认的主库疑似缺失记录可以补入");

  const candidates=await db.prepare("SELECT announcement_id AS announcementId,title,stock_name AS stockName FROM announcement WHERE stock_code=? AND announce_date=?").bind(row.stockCode,row.announceDate).all<{announcementId:string;title:string;stockName:string}>();
  const normalized=normalizeAnnouncementTitle(row.title,row.stockName);
  const existing=candidates.results.find((candidate)=>normalizeAnnouncementTitle(candidate.title,candidate.stockName)===normalized);
  const now=new Date().toISOString();
  if(existing){
    await db.batch([
      db.prepare("UPDATE exchange_observation SET match_status='exact',match_method='manual-recheck-normalized-title',matched_announcement_id=?,review_status='linked',reviewed_at=?,reviewed_by=?,review_note='补入前复核发现主库已有同一公告' WHERE id=?").bind(existing.announcementId,now,viewer,id),
      db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("exchange_observation",String(id),"linked_existing",JSON.stringify({announcementId:existing.announcementId}),viewer,now),
    ]);
    return {status:"linked",announcementId:existing.announcementId};
  }

  const pdfUrl=validatedOfficialPdfUrl(row.source,row.pdfUrl);
  const response=await fetchWithRetry(pdfUrl.toString(),{headers:exchangeDownloadHeaders(row.source)},2);
  if(!response.ok) throw new Error(`交易所 PDF 下载失败：HTTP ${response.status}`);
  const declaredSize=Number(response.headers.get("content-length")||0);
  if(declaredSize>30*1024*1024) throw new Error("交易所 PDF 超过 30MB 安全上限");
  const bytes=await response.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>30*1024*1024) throw new Error("交易所 PDF 文件为空或超过 30MB 安全上限");
  const signature=new Uint8Array(bytes,0,Math.min(5,bytes.byteLength));
  if(signature.length<5||signature[0]!==0x25||signature[1]!==0x50||signature[2]!==0x44||signature[3]!==0x46||signature[4]!==0x2d) throw new Error("交易所地址返回的内容不是有效 PDF");
  const sha256=hex(await crypto.subtle.digest("SHA-256",bytes));
  const sourceCode=row.source==="上交所"?"SSE":row.source==="深交所"?"SZSE":"BSE";
  const identityFingerprint=hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${row.source}:${row.sourceAnnouncementId}`)));
  const announcementId=`EX-${sourceCode}-${identityFingerprint.slice(0,20)}`;
  const r2Key=`announcements/${announcementId}.pdf`;
  await documents.put(r2Key,bytes,{httpMetadata:{contentType:"application/pdf"},customMetadata:{announcementId,sha256,officialSource:row.source,observationId:String(id)}});
  const payload={stockCode:row.stockCode,stockName:row.stockName,title:row.title,pdfUrl:pdfUrl.toString(),exchangeObservationId:id,sha256};
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO stock_info (code,name,exchange,status) VALUES (?,?,?,?)").bind(row.stockCode,row.stockName,row.source,"上市"),
    db.prepare("INSERT INTO announcement (announcement_id,stock_code,stock_name,title,announce_date,pdf_url,r2_key,source,crawl_time,md5,sha256,parse_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(announcementId,row.stockCode,row.stockName,row.title,row.announceDate,pdfUrl.toString(),r2Key,row.source,now,sha256,sha256,"archived"),
    db.prepare("INSERT INTO review_queue (announcement_id,event_type,reason,payload,status,created_at) VALUES (?,?,?,?,?,?)").bind(announcementId,"pledge","交易所差异公告已人工确认，等待结构化解析",JSON.stringify(payload),"pending",now),
    db.prepare("UPDATE exchange_observation SET match_status='exact',match_method='manual-confirmed-official-pdf',matched_announcement_id=?,review_status='promoted',reviewed_at=?,reviewed_by=?,review_note='已归档交易所官方 PDF 并进入解析队列' WHERE id=?").bind(announcementId,now,viewer,id),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("exchange_observation",String(id),"promote_official_announcement",JSON.stringify({announcementId,r2Key,sha256,size:bytes.byteLength,pdfUrl:pdfUrl.toString()}),viewer,now),
  ]);
  return {status:"promoted",announcementId,r2Key,sha256,size:bytes.byteLength};
}

async function runDailyProductionCycle(env:Env,date:string,runId:number,viewer:string) {
  const startedAt=new Date().toISOString();
  try{
    const ingestion=await ingestCninfo(env.DB,date);
    const beforeReconciliation=await dailyReportSnapshot(env.DB,date);
    const lastReconciliationAt=Date.parse(String(beforeReconciliation.reconciliation.lastRun?.finishedAt||""));
    const closedTradingDate=date<shanghaiDate();
    const recentReconciliation=beforeReconciliation.reconciliation.complete&&(closedTradingDate||(Number.isFinite(lastReconciliationAt)&&Date.now()-lastReconciliationAt<30*60*1000));
    const reconciliation=recentReconciliation
      ?{found:0,failures:0,results:beforeReconciliation.reconciliation.sourceRuns,skipped:true,reason:closedTradingDate?"历史交易日三所对账已完成且差异为零":"最近30分钟三所对账已完成且差异为零"}
      :await runExchangeReconciliation(env.DB,date,["sse","szse","bse"]);
    // Keep each invocation bounded; report polling advances the queue in later
    // idempotent runs instead of risking one oversized Worker execution.
    const processing=await processPendingQueue(env.DB,env.DOCUMENTS,3,env,date);
    const reviewCandidates=await env.DB.prepare("SELECT r.announcement_id AS id FROM review_queue r JOIN announcement a ON a.announcement_id=r.announcement_id WHERE r.status='pending' AND a.announce_date=? AND a.parse_status='review' AND a.parse_attempts<2 ORDER BY COALESCE(r.reviewed_at,r.created_at) ASC LIMIT 2").bind(date).all<{id:string}>();
    const reviews:unknown[]=[];
    for(const row of reviewCandidates.results){try{reviews.push(await withDeadline(processAnnouncement(env.DB,env.DOCUMENTS,row.id,env),25_000,`review ${row.id}`));}catch(error){reviews.push({id:row.id,status:"failed",error:error instanceof Error?error.message:"review failed"});}}
    const closingSnapshot=await dailyReportSnapshot(env.DB,date);
    const closing=closingSnapshot.ready&&closingSnapshot.cutoffPassed?await publishDailyReport(env,date,"automatic-production","自动关账：三所对账、公告分类与事件核验均已完成"):null;
    const finishedAt=new Date().toISOString();
    const result={date,ingestion,reconciliation:{found:reconciliation.found,failures:reconciliation.failures,results:reconciliation.results},processing,reviews,closing,startedAt,finishedAt};
    await env.DB.batch([
      env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,failures=?,message=? WHERE id=?").bind(finishedAt,(reconciliation.failures||processing.failures)?"completed_with_errors":"completed",ingestion.found,processing.events_created,reconciliation.failures+processing.failures,JSON.stringify(result),runId),
      env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('daily_production_last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(result),finishedAt),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("daily_production",date,"completed",JSON.stringify({runId,announcements:ingestion.found,events:processing.events_created,failures:reconciliation.failures+processing.failures}),viewer,finishedAt),
    ]);
    return result;
  }catch(error){
    const message=error instanceof Error?error.message:"daily production failed";const finishedAt=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE sync_run SET finished_at=?,status='failed',failures=failures+1,message=? WHERE id=?").bind(finishedAt,message,runId),
      env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('daily_production_last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify({date,runId,status:"failed",message,startedAt,finishedAt}),finishedAt),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("daily_production",date,"failed",JSON.stringify({runId,message}),viewer,finishedAt),
    ]);
    throw error;
  }
}

type AutomaticSyncState = {
  enabled: boolean;
  status: "disabled"|"fresh"|"running"|"started";
  targetDate: string;
  intervalMinutes: number;
  runId?: number;
  lastTriggeredAt?: string | null;
};

async function activeDailyProductionRun(db:D1Database,targetDate?:string) {
  const staleAt=new Date(Date.now()-5*60*1000).toISOString();
  await db.prepare("UPDATE sync_run SET finished_at=?,status='failed',failures=failures+1,message=COALESCE(message,'') || '；任务超过5分钟未结束，已自动释放锁' WHERE source='daily-production-cycle' AND status='running' AND started_at<?").bind(new Date().toISOString(),staleAt).run();
  const active=targetDate
    ?await db.prepare("SELECT id,started_at AS startedAt FROM sync_run WHERE source='daily-production-cycle' AND status='running' AND message LIKE ? ORDER BY id DESC LIMIT 1").bind(`%${targetDate}%`).first<{id:number;startedAt:string}>()
    :await db.prepare("SELECT id,started_at AS startedAt FROM sync_run WHERE source='daily-production-cycle' AND status='running' ORDER BY id DESC LIMIT 1").first<{id:number;startedAt:string}>();
  if(!active)return null;
  return active;
}

async function maybeStartAutomaticProduction(env:Env,ctx:ExecutionContext):Promise<AutomaticSyncState> {
  const enabled=env.AUTO_SYNC_ENABLED?.trim().toLowerCase()!=="false";
  const configuredInterval=Number(env.AUTO_SYNC_INTERVAL_MINUTES||5);
  const intervalMinutes=Number.isFinite(configuredInterval)?Math.min(Math.max(Math.round(configuredInterval),3),360):5;
  const targetDate=automaticProductionTargetDate();
  if(!enabled)return {enabled:false,status:"disabled",targetDate,intervalMinutes};

  const activeRun=await activeDailyProductionRun(env.DB,targetDate);
  if(activeRun)return {enabled:true,status:"running",targetDate,intervalMinutes,runId:activeRun.id,lastTriggeredAt:activeRun.startedAt};
  const startedAt=new Date().toISOString();
  const lockCutoff=new Date(Date.now()-intervalMinutes*60000).toISOString();
  const triggerKey=`automatic_production_trigger:${targetDate}`;
  const lock=await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE pipeline_state.updated_at<=? RETURNING updated_at AS updatedAt").bind(triggerKey,JSON.stringify({targetDate,reason:"daily-report-request",status:"starting"}),startedAt,lockCutoff).first<{updatedAt:string}>();
  if(!lock){
    const existing=await env.DB.prepare("SELECT updated_at AS updatedAt FROM pipeline_state WHERE key=?").bind(triggerKey).first<{updatedAt:string}>();
    return {enabled:true,status:"fresh",targetDate,intervalMinutes,lastTriggeredAt:existing?.updatedAt||null};
  }
  const run=await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("daily-production-cycle",startedAt,"running",`automatic production catch-up ${targetDate}`).first<{id:number}>();
  if(!run?.id)return {enabled:true,status:"fresh",targetDate,intervalMinutes,lastTriggeredAt:startedAt};
  await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(triggerKey,JSON.stringify({targetDate,runId:run.id,reason:"daily-report-request"}),startedAt).run();
  ctx.waitUntil(runDailyProductionCycle(env,targetDate,run.id,"automatic-production").catch(()=>undefined));
  return {enabled:true,status:"started",targetDate,intervalMinutes,runId:run.id,lastTriggeredAt:startedAt};
}

async function maybeStartAutomaticMaintenance(env:Env,ctx:ExecutionContext) {
  const enabled=env.AUTO_SYNC_ENABLED?.trim().toLowerCase()!=="false";if(!enabled)return {enabled:false,status:"disabled"};
  const startedAt=new Date().toISOString();const lockCutoff=new Date(Date.now()-24*60*60*1000).toISOString();
  const lock=await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('automatic_maintenance_trigger',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE pipeline_state.updated_at<=? RETURNING updated_at AS updatedAt").bind(JSON.stringify({reason:"public-health-check",status:"starting"}),startedAt,lockCutoff).first<{updatedAt:string}>();
  if(!lock){const existing=await env.DB.prepare("SELECT updated_at AS updatedAt FROM pipeline_state WHERE key='automatic_maintenance_trigger'").first<{updatedAt:string}>();return {enabled:true,status:"fresh",lastTriggeredAt:existing?.updatedAt||null};}
  await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('automatic_maintenance_trigger',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify({reason:"public-health-check",status:"running"}),startedAt).run();
  ctx.waitUntil(runMaintenanceCycle(env,"automatic-daily-maintenance").catch(()=>undefined));
  return {enabled:true,status:"started",lastTriggeredAt:startedAt};
}

const stripePlanPrices=(env:Env)=>({pro:env.STRIPE_PRICE_PRO_MONTHLY,team:env.STRIPE_PRICE_TEAM_MONTHLY,global:env.STRIPE_PRICE_GLOBAL_MONTHLY});
const stripePlanFromPrice=(env:Env,priceId:string|null|undefined)=>Object.entries(stripePlanPrices(env)).find(([,id])=>id&&id===priceId)?.[0]||"free";
const paidBillingStatuses=new Set(["active","trialing"]);
const entitlementsFor=(plan:string,status:string)=>{const paid=plan!=="free"&&paidBillingStatuses.has(status);return {verifiedFeed:true,officialSources:true,csvExport:true,advancedExport:paid,fullHistory:paid,researchReports:paid,teamWorkspace:paid&&["team","global"].includes(plan),otcBundle:paid&&plan==="global"};};
async function stripePost(env:Env,path:string,fields:Record<string,string>) {
  if(!env.STRIPE_SECRET_KEY)throw new Error("Stripe 尚未配置");
  const response=await fetch(`https://api.stripe.com/v1/${path}`,{method:"POST",headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(fields)});
  const payload=await response.json<Record<string,unknown>>().catch(()=>({}));
  if(!response.ok)throw new Error(String((payload.error as {message?:string}|undefined)?.message||`Stripe HTTP ${response.status}`));
  return payload;
}
function constantTimeHexEqual(left:string,right:string){if(left.length!==right.length)return false;let diff=0;for(let i=0;i<left.length;i++)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0;}
async function verifyStripeSignature(rawBody:string,header:string|null,secret:string) {
  if(!header)return false;const parts=header.split(",");const timestamp=parts.find((part)=>part.startsWith("t="))?.slice(2);const signatures=parts.filter((part)=>part.startsWith("v1=")).map((part)=>part.slice(3));
  if(!timestamp||!signatures.length||Math.abs(Date.now()/1000-Number(timestamp))>300)return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const expected=hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return signatures.some((signature)=>constantTimeHexEqual(signature,expected));
}
type StripeEvent={id:string;type:string;data:{object:Record<string,unknown>}};
async function applyStripeEvent(db:D1Database,env:Env,event:StripeEvent,rawBody:string) {
  const existing=await db.prepare("SELECT event_id FROM billing_event WHERE event_id=?").bind(event.id).first();if(existing)return {duplicate:true};
  const object=event.data.object;const now=new Date().toISOString();const customerId=String(object.customer||"");const subscriptionId=String(object.subscription||object.id||"");
  const metadata=(object.metadata||{}) as Record<string,string>;let userId=metadata.user_id||String(object.client_reference_id||"");
  if(!userId&&customerId){const account=await db.prepare("SELECT user_id AS userId FROM billing_account WHERE stripe_customer_id=?").bind(customerId).first<{userId:string}>();userId=account?.userId||"";}
  const eventStatement=db.prepare("INSERT INTO billing_event (event_id,type,payload_hash,processed_at) VALUES (?,?,?,?)").bind(event.id,event.type,hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(rawBody))),now);
  if(!userId){await eventStatement.run();return {processed:true,accountUpdated:false};}
  if(event.type==="checkout.session.completed"){
    await db.batch([
      db.prepare("UPDATE billing_account SET stripe_customer_id=?,stripe_subscription_id=?,status='processing',updated_at=? WHERE user_id=?").bind(customerId,subscriptionId,now,userId),eventStatement,
    ]);return {processed:true,accountUpdated:true};
  }
  if(event.type.startsWith("customer.subscription.")){
    const status=String(object.status||"inactive");const items=((object.items as {data?:Array<{price?:{id?:string}}>}|undefined)?.data||[]);const priceId=items[0]?.price?.id;const active=["active","trialing"].includes(status);const periodEnd=object.current_period_end?new Date(Number(object.current_period_end)*1000).toISOString():null;
    await db.batch([
      db.prepare("UPDATE billing_account SET stripe_customer_id=COALESCE(NULLIF(?,''),stripe_customer_id),stripe_subscription_id=?,plan=?,status=?,current_period_end=?,updated_at=? WHERE user_id=?").bind(customerId,String(object.id||subscriptionId),active?stripePlanFromPrice(env,priceId):"free",status,periodEnd,now,userId),eventStatement,
    ]);return {processed:true,accountUpdated:true,plan:active?stripePlanFromPrice(env,priceId):"free",status};
  }
  await eventStatement.run();return {processed:true,accountUpdated:false};
}

async function dailyReportSnapshot(db:D1Database,date:string) {
  const [announcement,event,verification,reconciliationRun,unresolved,published] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN parse_status IN ('parsed','ignored','rejected') THEN 1 ELSE 0 END) AS classified,SUM(CASE WHEN parse_status NOT IN ('parsed','ignored','rejected') THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN parse_status IN ('queued','archived','processing') THEN 1 ELSE 0 END) AS processing,SUM(CASE WHEN parse_status='review' THEN 1 ELSE 0 END) AS review FROM announcement WHERE announce_date=?").bind(date).first<{total:number;classified:number;pending:number;processing:number;review:number}>(),
    db.prepare("SELECT COUNT(*) AS total,COUNT(DISTINCT stock_code) AS companies,SUM(CASE WHEN type LIKE '%解除%' THEN 1 ELSE 0 END) AS releases,SUM(CASE WHEN type LIKE '%补充%' THEN 1 ELSE 0 END) AS supplemental FROM pledge WHERE announce_date=?").bind(date).first<{total:number;companies:number;releases:number;supplemental:number}>(),
    db.prepare("SELECT SUM(CASE WHEN verification_status='human_verified' THEN 1 ELSE 0 END) AS humanVerified,SUM(CASE WHEN verification_status='ai_reviewed' THEN 1 ELSE 0 END) AS aiReviewed,SUM(CASE WHEN verification_status='rules_validated' THEN 1 ELSE 0 END) AS rulesValidated FROM pledge WHERE announce_date=?").bind(date).first(),
    db.prepare("SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,message FROM sync_run WHERE source='exchange-reconciliation' AND json_valid(message) AND json_extract(message,'$.date')=? ORDER BY id DESC LIMIT 1").bind(date).first<{id:number;startedAt:string;finishedAt:string;status:string;message:string}>(),
    db.prepare("SELECT COUNT(*) AS total FROM exchange_observation WHERE announce_date=? AND ((match_status IN ('likely','ambiguous') AND review_status='pending') OR (match_status='missing_primary' AND review_status='pending'))").bind(date).first<{total:number}>(),
    db.prepare("SELECT date,cutoff_at AS cutoffAt,status,announcement_count AS announcementCount,event_count AS eventCount,company_count AS companyCount,reconciliation_status AS reconciliationStatus,report_version AS reportVersion,published_at AS publishedAt,notes FROM daily_report WHERE date=?").bind(date).first(),
  ]);
  const reconciliationMessage=reconciliationRun?JSON.parse(reconciliationRun.message||"{}"):{};
  const sourceRuns=(Array.isArray(reconciliationMessage.results)?reconciliationMessage.results:[]) as Array<{source:string;status:string;observed?:number;exact?:number;likely?:number;missing?:number}>;
  const successfulSources=sourceRuns.filter((row)=>row.status==="completed").length;
  const reconciliationComplete=successfulSources===3&&Number(unresolved?.total||0)===0;
  const contentComplete=Number(announcement?.total||0)>0&&Number(announcement?.pending||0)===0;
  const ready=reconciliationComplete&&contentComplete;
  const cutoffAt=`${date}T20:00:00+08:00`;
  const cutoffPassed=Date.now()>=Date.parse(cutoffAt);
  const status=(published as {status?:string}|null)?.status==="published"?"published":ready?"ready_to_close":cutoffPassed?"reviewing":"collecting";
  return {date,cutoffAt,status,ready,cutoffPassed,announcement:announcement||{total:0,classified:0,pending:0},event:event||{total:0,companies:0,releases:0,supplemental:0},verification:verification||{},reconciliation:{complete:reconciliationComplete,successfulSources,requiredSources:3,unresolved:Number(unresolved?.total||0),sourceRuns,lastRun:reconciliationRun||null},published:published||null};
}

type DailyArtifactEvent={announcementId:string;code:string;name:string;shareholder:string;pledgee:string;amount:string;ratio:string;type:string;verificationStatus:string};
const xmlEscape=(value:unknown)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
const compactArtifactText=(value:unknown,limit:number)=>{const text=String(value??"—").replace(/\s+/g," ").trim()||"—";return text.length>limit?`${text.slice(0,Math.max(1,limit-1))}…`:text;};
const dailyArtifactKey=(date:string,version:number,extension:"png"|"pdf")=>`daily-reports/${date}/HBF-A-share-pledge-daily-v${version}.${extension}`;

function renderDailyReportSvg(date:string,version:number,events:DailyArtifactEvent[]){
  const width=1500,rowHeight=112,top=458,height=Math.max(920,top+events.length*rowHeight+160);
  const highRatio=events.filter((row)=>Number.parseFloat(row.ratio)>=50).length;
  const companies=new Set(events.map((row)=>row.code)).size;
  const supplemental=events.filter((row)=>row.type.includes("补充")).length;
  const cells=[70,230,475,770,1030,1240];
  const metrics=[["质押事件",events.length],["涉及公司",companies],["补充质押",supplemental],["高比例信号",highRatio]];
  const metricSvg=metrics.map(([label,value],index)=>{const x=70+index*350;return `<g><rect x="${x}" y="280" width="310" height="115" rx="8" fill="#fff"/><text x="${x+24}" y="322" class="metricLabel">${label}</text><text x="${x+24}" y="374" class="metricValue">${value}</text></g>`;}).join("");
  const rows=events.map((row,index)=>{const y=top+index*rowHeight;return `<g>${index%2===0?`<rect x="50" y="${y-10}" width="1400" height="${rowHeight}" fill="#ebe6dc"/>`:""}<text x="${cells[0]}" y="${y+30}" class="rowStrong">${xmlEscape(compactArtifactText(`${row.name} ${row.code}`,14))}</text><text x="${cells[1]}" y="${y+30}" class="row">${xmlEscape(compactArtifactText(row.shareholder,15))}</text><text x="${cells[2]}" y="${y+30}" class="row">${xmlEscape(compactArtifactText(row.pledgee,18))}</text><text x="${cells[3]}" y="${y+30}" class="rowStrong">${xmlEscape(compactArtifactText(row.amount,16))}</text><text x="${cells[4]}" y="${y+30}" class="rowStrong">${xmlEscape(row.ratio||"—")}</text><text x="${cells[5]}" y="${y+30}" class="row">${xmlEscape(compactArtifactText(row.type,8))}</text><text x="${cells[0]}" y="${y+70}" class="evidence">公告 ${xmlEscape(compactArtifactText(row.announcementId,38))} · ${xmlEscape(row.verificationStatus||"已核验")}</text></g>`;}).join("");
  const headers=["股票","质押股东","质权人","股份数量","占个人持股","事件"].map((label,index)=>`<text x="${cells[index]}" y="440" class="tableHead">${label}</text>`).join("");
  return {width,height,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font-family:'Noto Sans CJK SC','Microsoft YaHei',sans-serif}.brand{font-size:32px;font-weight:700;fill:#fff}.date{font-size:62px;font-weight:700;fill:#fff}.subtitle{font-size:24px;fill:#b9c9e4}.metricLabel{font-size:22px;fill:#65728a}.metricValue{font-size:42px;font-weight:700;fill:#0b1f3a}.tableHead{font-size:21px;font-weight:700;fill:#0b1f3a}.row{font-size:21px;fill:#12213a}.rowStrong{font-size:22px;font-weight:700;fill:#12213a}.evidence{font-size:17px;fill:#718096}.footer{font-size:20px;fill:#0b1f3a}.watermark{font-size:46px;font-weight:700;fill:#0b1f3a;opacity:.22}</style><rect width="${width}" height="${height}" fill="#f4f0e8"/><rect width="${width}" height="250" fill="#0b1f3a"/><text x="70" y="72" class="brand">HBF · A股质押日报</text><text x="70" y="158" class="date">${date}</text><text x="70" y="207" class="subtitle">每日20:00关账｜官方公告三所交叉核验｜正式版本 V${version}</text>${metricSvg}${headers}${rows}<text x="70" y="${height-72}" class="footer">已关账发布｜事件 ${events.length} 条｜PNG 与 PDF 生成自同一份锁定数据</text><text x="1430" y="${height-62}" text-anchor="end" class="watermark">HBF</text></svg>`};
}

function pdfFromJpeg(jpeg:ArrayBuffer,width:number,height:number){
  const encoder=new TextEncoder();const chunks:Uint8Array[]=[];let size=0;const offsets:number[]=[];
  const push=(value:string|ArrayBuffer|Uint8Array)=>{const bytes=typeof value==="string"?encoder.encode(value):value instanceof Uint8Array?value:new Uint8Array(value);chunks.push(bytes);size+=bytes.byteLength;};
  const object=(id:number,body:string)=>{offsets[id]=size;push(`${id} 0 obj\n${body}\nendobj\n`);};
  const pageWidth=842,pageHeight=Math.max(595,Math.round(pageWidth*height/width));
  push("%PDF-1.4\n%HBF\n");object(1,"<< /Type /Catalog /Pages 2 0 R >>");object(2,"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4]=size;push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`);push(jpeg);push("\nendstream\nendobj\n");
  const content=`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;object(5,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref=size;push("xref\n0 6\n0000000000 65535 f \n");for(let id=1;id<=5;id++)push(`${String(offsets[id]).padStart(10,"0")} 00000 n \n`);push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const result=new Uint8Array(size);let cursor=0;for(const chunk of chunks){result.set(chunk,cursor);cursor+=chunk.byteLength;}return result;
}

async function generateDailyReportArtifacts(env:Env,date:string,version:number){
  const eventResult=await env.DB.prepare("SELECT p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.type,p.verification_status AS verificationStatus FROM pledge p WHERE p.announce_date=? ORDER BY CASE WHEN p.type LIKE '%补充%' THEN 0 WHEN p.type NOT LIKE '%解除%' THEN 1 ELSE 2 END,p.id DESC").bind(date).all<DailyArtifactEvent>();
  const rendered=renderDailyReportSvg(date,version,eventResult.results);const makeStream=()=>new Response(rendered.svg,{headers:{"content-type":"image/svg+xml; charset=utf-8"}}).body!;
  const [pngResponse,jpegResponse]=await Promise.all([env.IMAGES.input(makeStream()).transform({width:rendered.width}).output({format:"image/png",quality:100}).response(),env.IMAGES.input(makeStream()).transform({width:rendered.width}).output({format:"image/jpeg",quality:94}).response()]);
  if(!pngResponse.ok||!jpegResponse.ok)throw new Error(`artifact rendering failed: PNG ${pngResponse.status}, JPEG ${jpegResponse.status}`);
  const [png,jpeg]=await Promise.all([pngResponse.arrayBuffer(),jpegResponse.arrayBuffer()]);const pdf=pdfFromJpeg(jpeg,rendered.width,rendered.height);
  const pngKey=dailyArtifactKey(date,version,"png"),pdfKey=dailyArtifactKey(date,version,"pdf");
  await Promise.all([env.DOCUMENTS.put(pngKey,png,{httpMetadata:{contentType:"image/png"},customMetadata:{date,version:String(version),source:"locked-daily-report"}}),env.DOCUMENTS.put(pdfKey,pdf,{httpMetadata:{contentType:"application/pdf"},customMetadata:{date,version:String(version),source:"locked-daily-report"}})]);
  return {pngKey,pdfKey,pngBytes:png.byteLength,pdfBytes:pdf.byteLength};
}

async function dailyArtifactLinks(env:Env,date:string,version:number){
  const pngKey=dailyArtifactKey(date,version,"png"),pdfKey=dailyArtifactKey(date,version,"pdf");const [png,pdf]=await Promise.all([env.DOCUMENTS.head(pngKey),env.DOCUMENTS.head(pdfKey)]);
  return {png:png?`/api/documents/${encodeURIComponent(pngKey)}`:null,pdf:pdf?`/api/documents/${encodeURIComponent(pdfKey)}`:null,locked:Boolean(png&&pdf)};
}

async function publishDailyReport(env:Env,date:string,viewer:string,notes="") {
  const db=env.DB;const snapshot=await dailyReportSnapshot(db,date);
  if(!snapshot.ready)return {ok:false as const,status:"not_ready",snapshot};
  const now=new Date().toISOString();const announcement=snapshot.announcement as {total?:number};const event=snapshot.event as {total?:number;companies?:number};
  await db.batch([
    db.prepare("INSERT INTO daily_report (date,cutoff_at,status,announcement_count,event_count,company_count,reconciliation_status,report_version,published_at,published_by,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET status='published',announcement_count=excluded.announcement_count,event_count=excluded.event_count,company_count=excluded.company_count,reconciliation_status=excluded.reconciliation_status,report_version=CASE WHEN daily_report.status='published' THEN daily_report.report_version ELSE daily_report.report_version+1 END,published_at=excluded.published_at,published_by=excluded.published_by,notes=excluded.notes").bind(date,snapshot.cutoffAt,"published",Number(announcement.total||0),Number(event.total||0),Number(event.companies||0),"verified",1,now,viewer,notes.trim().slice(0,500)||null),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("daily_report",date,"published",JSON.stringify({announcements:announcement.total||0,events:event.total||0,companies:event.companies||0}),viewer,now),
  ]);
  const saved=await db.prepare("SELECT report_version AS reportVersion FROM daily_report WHERE date=?").bind(date).first<{reportVersion:number}>();const version=Number(saved?.reportVersion||1);
  try{const artifacts=await generateDailyReportArtifacts(env,date,version);await db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("daily_report",date,"artifacts_generated",JSON.stringify(artifacts),viewer,new Date().toISOString()).run();return {ok:true as const,date,status:"published",publishedAt:now,reportVersion:version,artifacts};}
  catch(error){const artifactError=error instanceof Error?error.message:"artifact generation failed";await db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("daily_report",date,"artifacts_failed",JSON.stringify({artifactError}),viewer,new Date().toISOString()).run();return {ok:true as const,date,status:"published",publishedAt:now,reportVersion:version,artifactError};}
}

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  if(url.pathname==="/api/billing/webhook"&&request.method==="POST"){
    if(!env.STRIPE_WEBHOOK_SECRET)return json({error:"Stripe webhook 未配置"},{status:503});
    const rawBody=await request.text();const valid=await verifyStripeSignature(rawBody,request.headers.get("stripe-signature"),env.STRIPE_WEBHOOK_SECRET);
    if(!valid)return json({error:"invalid Stripe signature"},{status:400});
    const event=JSON.parse(rawBody) as StripeEvent;const result=await applyStripeEvent(env.DB,env,event,rawBody);return json({received:true,...result});
  }
  if(url.pathname==="/api/billing/status"&&request.method==="GET"){
    const viewer=viewerId(request);const configured=Boolean(env.STRIPE_SECRET_KEY&&Object.values(stripePlanPrices(env)).some(Boolean));
    if(!viewer)return json({authenticated:false,configured,plan:"free",status:"anonymous",entitlements:entitlementsFor("free","anonymous")});
    const account=await env.DB.prepare("SELECT email,stripe_customer_id AS stripeCustomerId,plan,status,current_period_end AS currentPeriodEnd,updated_at AS updatedAt FROM billing_account WHERE user_id=?").bind(viewer).first();
    const plan=String((account as {plan?:string}|null)?.plan||"free");const status=String((account as {status?:string}|null)?.status||"inactive");return json({authenticated:true,configured,plan,status,...account,entitlements:entitlementsFor(plan,status)});
  }
  if(url.pathname==="/api/billing/checkout"&&request.method==="POST"){
    const viewer=viewerId(request);const email=viewerEmail(request);if(!viewer||!email)return json({error:"请先登录后订阅"},{status:401});
    const input=await request.json<{plan?:"pro"|"team"|"global";locale?:"zh"|"en"}>().catch(()=>({}));const plan=input.plan||"pro";const priceId=stripePlanPrices(env)[plan];
    if(!env.STRIPE_SECRET_KEY||!priceId)return json({error:"支付通道尚未完成商户配置，请稍后再试"},{status:503});
    const now=new Date().toISOString();let account=await env.DB.prepare("SELECT stripe_customer_id AS stripeCustomerId FROM billing_account WHERE user_id=?").bind(viewer).first<{stripeCustomerId:string}>();
    if(!account?.stripeCustomerId){
      const customer=await stripePost(env,"customers",{email,"metadata[user_id]":viewer,"metadata[source]":"pledge-radar"});const customerId=String(customer.id||"");if(!customerId)throw new Error("Stripe customer creation failed");
      await env.DB.prepare("INSERT INTO billing_account (user_id,email,stripe_customer_id,plan,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,stripe_customer_id=excluded.stripe_customer_id,updated_at=excluded.updated_at").bind(viewer,email,customerId,"free","inactive",now,now).run();account={stripeCustomerId:customerId};
    }
    const returnPath=input.locale==="en"?"/en/pricing":"/pricing";
    const session=await stripePost(env,"checkout/sessions",{mode:"subscription","line_items[0][price]":priceId,"line_items[0][quantity]":"1",customer:account.stripeCustomerId,"client_reference_id":viewer,"metadata[user_id]":viewer,"metadata[plan]":plan,"subscription_data[metadata][user_id]":viewer,"subscription_data[metadata][plan]":plan,success_url:`${url.origin}${returnPath}?checkout=success`,cancel_url:`${url.origin}${returnPath}?checkout=cancelled`,allow_promotion_codes:"true","billing_address_collection":"auto"});
    return json({ok:true,url:session.url,sessionId:session.id});
  }
  if(url.pathname==="/api/billing/portal"&&request.method==="POST"){
    const viewer=viewerId(request);if(!viewer)return json({error:"请先登录后管理订阅"},{status:401});
    const input=await request.json<{locale?:"zh"|"en"}>().catch(()=>({}));
    const account=await env.DB.prepare("SELECT stripe_customer_id AS stripeCustomerId FROM billing_account WHERE user_id=?").bind(viewer).first<{stripeCustomerId:string}>();if(!account?.stripeCustomerId)return json({error:"尚未建立付费账户"},{status:404});
    const session=await stripePost(env,"billing_portal/sessions",{customer:account.stripeCustomerId,return_url:`${url.origin}${input.locale==="en"?"/en/pricing":"/pricing"}`});return json({ok:true,url:session.url});
  }
  if(url.pathname==="/api/daily-report"&&request.method==="GET"){
    const automaticProduction=await maybeStartAutomaticProduction(env,ctx);
    const requested=url.searchParams.get("date");
    const latest=await env.DB.prepare("SELECT MAX(announce_date) AS date FROM announcement").first<{date:string}>();
    const date=requested&&/^\d{4}-\d{2}-\d{2}$/.test(requested)?requested:latest?.date||latestTradingDate();
    const [snapshot,events,quotaState]=await Promise.all([
      dailyReportSnapshot(env.DB,date),
      env.DB.prepare("SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,p.verification_status AS verificationStatus,a.pdf_url AS pdfUrl FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id WHERE p.announce_date=? ORDER BY CASE WHEN p.type LIKE '%补充%' THEN 0 WHEN p.type NOT LIKE '%解除%' THEN 1 ELSE 2 END,p.id DESC").bind(date).all(),
      env.DB.prepare("SELECT value FROM pipeline_state WHERE key='openai_quota_blocked_until'").first<{value:string}>(),
    ]);
    const blockedUntil=quotaState?.value&&Date.parse(quotaState.value)>Date.now()?quotaState.value:null;const version=Number((snapshot.published as {reportVersion?:number}|null)?.reportVersion||1);const artifacts=snapshot.status==="published"?await dailyArtifactLinks(env,date,version):{png:null,pdf:null,locked:false};
    return json({...snapshot,events:events.results,automaticProduction,automatedReview:{configured:Boolean(env.OPENAI_API_KEY),available:Boolean(env.OPENAI_API_KEY)&&!blockedUntil,blockedUntil},artifacts,methodology:"交易日20:00停止纳入新公告；三所对账、公告分类和全部事件核验完成后方可关账发布",deliverables:{image:"关账后从锁定数据生成并归档PNG长图",pdf:"关账后从同一锁定数据生成并归档PDF"},generatedAt:new Date().toISOString()});
  }
  if(url.pathname==="/api/daily-reports"&&request.method==="GET"){
    const rows=await env.DB.prepare("SELECT a.date,a.announcements,a.events,a.companies,a.pending,COALESCE(r.status,'draft') AS savedStatus,r.published_at AS publishedAt FROM (SELECT d.announce_date AS date,COUNT(DISTINCT d.announcement_id) AS announcements,COUNT(DISTINCT p.id) AS events,COUNT(DISTINCT p.stock_code) AS companies,COUNT(DISTINCT CASE WHEN d.parse_status NOT IN ('parsed','ignored','rejected') THEN d.announcement_id END) AS pending FROM announcement d LEFT JOIN pledge p ON p.announcement_id=d.announcement_id GROUP BY d.announce_date ORDER BY d.announce_date DESC LIMIT 90) a LEFT JOIN daily_report r ON r.date=a.date ORDER BY a.date DESC").all<{date:string}>();
    const data=[];for(const row of rows.results){const snapshot=await dailyReportSnapshot(env.DB,row.date);data.push({...row,status:snapshot.status,ready:snapshot.ready,reconciliation:snapshot.reconciliation});}
    return json({data,scope:"仅展示按交易日生成的关账报告；历史数据库查询不再作为公开产品",generatedAt:new Date().toISOString()});
  }
  if(url.pathname==="/api/daily-report/close"&&request.method==="POST"){
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const input=await request.json<{date?:string;notes?:string}>().catch(()=>({}));const date=input.date||latestTradingDate();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"无效报告日期"},{status:400});
    const result=await publishDailyReport(env,date,viewer,input.notes||"");if(!result.ok)return json({error:"当日尚未满足关账条件",snapshot:result.snapshot},{status:409});
    return json(result);
  }
  if (url.pathname === "/api/health") {
    const [stats,quotaState,automaticSync,automaticMaintenance] = await Promise.all([
      env.DB.prepare("SELECT (SELECT COUNT(*) FROM announcement) announcements, (SELECT COUNT(*) FROM pledge) events, (SELECT COUNT(*) FROM review_queue WHERE status='pending') pending_reviews, (SELECT COUNT(*) FROM announcement WHERE parse_status='ignored') ignored_announcements").first(),
      env.DB.prepare("SELECT value FROM pipeline_state WHERE key='openai_quota_blocked_until'").first<{value:string}>(),
      maybeStartAutomaticProduction(env,ctx),
      maybeStartAutomaticMaintenance(env,ctx),
    ]);
    const quotaBlocked = Boolean(quotaState?.value && Date.parse(quotaState.value) > Date.now());
    return json({ status: "ok", storage: { d1: true, r2: true }, automaticSync, automaticMaintenance, automatedReview: { configured: Boolean(env.OPENAI_API_KEY), available: Boolean(env.OPENAI_API_KEY) && !quotaBlocked, mode: env.OPENAI_API_KEY ? "rules-then-openai" : "rules-only", model: env.OPENAI_API_KEY ? (env.OPENAI_OCR_MODEL || "gpt-5.6-luna") : null, quotaBlockedUntil: quotaBlocked ? quotaState?.value : null, maxAutomaticAttempts: 2 }, billing:{provider:"stripe",configured:Boolean(env.STRIPE_SECRET_KEY&&env.STRIPE_WEBHOOK_SECRET&&Object.values(stripePlanPrices(env)).every(Boolean)),mode:env.STRIPE_SECRET_KEY?.startsWith("sk_live_")?"live":env.STRIPE_SECRET_KEY?"test":"disabled"}, stats, timestamp: new Date().toISOString() });
  }
  if (url.pathname === "/api/stats" && request.method === "GET") {
    const [daily,eventTypes,pledgees,statuses] = await Promise.all([
      env.DB.prepare("SELECT announce_date AS date,COUNT(*) AS announcements,SUM(CASE WHEN parse_status='parsed' THEN 1 ELSE 0 END) AS parsed FROM announcement GROUP BY announce_date ORDER BY announce_date DESC LIMIT 14").all(),
      env.DB.prepare("SELECT type AS name,COUNT(*) AS value FROM pledge GROUP BY type ORDER BY value DESC").all(),
      env.DB.prepare("SELECT pledgee AS name,COUNT(*) AS value,SUM(pledge_amount) AS amount FROM pledge GROUP BY pledgee ORDER BY value DESC,amount DESC LIMIT 8").all(),
      env.DB.prepare("SELECT parse_status AS name,COUNT(*) AS value FROM announcement GROUP BY parse_status ORDER BY value DESC").all(),
    ]);
    return json({ daily:daily.results.reverse(),eventTypes:eventTypes.results,pledgees:pledgees.results,statuses:statuses.results });
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const input = await request.json<{date?:string}>().catch(() => ({})); const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : shanghaiDate(-1);
    const startedAt = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("official-adapters",startedAt,"running","V1 适配器初始化").first<{id:number}>();
    try {
      const result = await ingestCninfo(env.DB,date);
      await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,events_created=?,message=? WHERE id=?").bind(new Date().toISOString(),"completed",result.found,0,`巨潮资讯 ${date}：新增 ${result.inserted} 条待解析公告`,run?.id).run();
      ctx.waitUntil(processPendingQueue(env.DB,env.DOCUMENTS,3,env));
      return json({ ok:true,run_id:run?.id,date,announcements_found:result.found,announcements_inserted:result.inserted,events_created:0,auto_processing:true,mode:"cninfo-live" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步失败";
      await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,failures=1,message=? WHERE id=?").bind(new Date().toISOString(),"failed",message,run?.id).run();
      return json({ ok:false,run_id:run?.id,error:message },{status:502});
    }
  }
  if (url.pathname === "/api/backfill-extend" && request.method === "GET") {
    const [cursor, coverage] = await Promise.all([
      env.DB.prepare("SELECT value,updated_at AS updatedAt FROM pipeline_state WHERE key='historical_backfill_cursor'").first(),
      env.DB.prepare("SELECT MIN(announce_date) AS earliestDate,MAX(announce_date) AS latestDate,COUNT(*) AS announcements FROM announcement").first(),
    ]);
    return json({ cursor, coverage, generatedAt:new Date().toISOString(), scope:"每日向更早日期滚动回补；游标独立于是否发现公告" });
  }
  if (url.pathname === "/api/backfill-extend" && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const input = await request.json<{days?:number}>().catch(() => ({}));
    const tradingDays = Math.min(Math.max(Number(input.days) || 5,1),7);
    const result=await runHistoricalBackfillBatch(env,tradingDays);
    if(result.inserted)ctx.waitUntil(processPendingQueue(env.DB,env.DOCUMENTS,10,env));
    return json({...result,auto_processing:Boolean(result.inserted)});
  }
  if (url.pathname === "/api/backfill-plan" && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const input = await request.json<{start?:string;end?:string}>().catch(() => ({}));
    const end = input.end || shanghaiDate(); const start = input.start || shanghaiDate(-6);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return json({ error: "invalid-date-range" }, { status: 400 });
    const startDate = new Date(`${start}T00:00:00Z`); const endDate = new Date(`${end}T00:00:00Z`); const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    if (days > 31) return json({ error: "date-range-too-large", maxDays: 31 }, { status: 400 });
    const existing = await env.DB.prepare("SELECT DISTINCT announce_date AS date FROM announcement WHERE announce_date BETWEEN ? AND ?").bind(start,end).all<{date:string}>(); const present = new Set(existing.results.map((row) => row.date)); const dates: string[] = [];
    for (let index = 0; index < days; index++) { const date = new Date(startDate); date.setUTCDate(startDate.getUTCDate() + index); const key = date.toISOString().slice(0,10); if (isTradingDate(key) && !present.has(key)) dates.push(key); }
    if (!dates.length) return json({ ok:true,run_id:null,dates:[],found:0,inserted:0,failures:0,message:"没有待回补日期" });
    const startedAt = new Date().toISOString(); const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("historical-backfill-gap",startedAt,"running",`回补缺口 ${dates.length} 日`).first<{id:number}>();
    let found = 0; let inserted = 0; let failures = 0; const results: {date:string;found:number;inserted:number;error?:string}[] = [];
    for (const date of dates) { try { const result = await ingestCninfo(env.DB,date); found += result.found; inserted += result.inserted; results.push({date,...result}); } catch (error) { failures++; results.push({date,found:0,inserted:0,error:error instanceof Error ? error.message : "sync failed"}); } }
    await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,failures=?,message=? WHERE id=?").bind(new Date().toISOString(),failures ? "completed_with_errors" : "completed",found,failures,`缺口回补 ${dates.length} 日：发现 ${found} 条，新增 ${inserted} 条`,run?.id).run();
    return json({ ok:true,run_id:run?.id,dates:results,found,inserted,failures,auto_processing:true });
  }
  if (url.pathname === "/api/backfill-plan" && request.method === "GET") {
    const end = url.searchParams.get("end") || shanghaiDate();
    const start = url.searchParams.get("start") || shanghaiDate(-6);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return json({ error: "invalid-date-range" }, { status: 400 });
    const startDate = new Date(`${start}T00:00:00Z`); const endDate = new Date(`${end}T00:00:00Z`); const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    if (days > 31) return json({ error: "date-range-too-large", maxDays: 31 }, { status: 400 });
    const rows = await env.DB.prepare("SELECT announce_date AS date,COUNT(*) AS announcements FROM announcement WHERE announce_date BETWEEN ? AND ? GROUP BY announce_date ORDER BY announce_date").bind(start,end).all<{date:string;announcements:number}>();
    const present = new Map(rows.results.map((row) => [row.date, row.announcements])); const missingDates: string[] = []; const calendar: {date:string;announcements:number}[] = [];
    for (let index = 0; index < days; index++) { const date = new Date(startDate); date.setUTCDate(startDate.getUTCDate() + index); const key = date.toISOString().slice(0,10); const count = present.get(key) || 0; calendar.push({ date: key, announcements: count }); if (isTradingDate(key) && !count) missingDates.push(key); }
    return json({ start, end, days, calendar, missingDates, scope: "公告日期缺口提示；空白日期可能是周末、节假日或尚未抓取，需回补后确认" });
  }
  if (url.pathname === "/api/backfill" && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const input = await request.json<{days?:number;endDate?:string}>().catch(() => ({}));
    const days = Math.min(Math.max(Number(input.days) || 7,1),7);
    const endDate = input.endDate && /^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? input.endDate : shanghaiDate();
    const end = new Date(`${endDate}T00:00:00Z`); const startedAt = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("historical-backfill",startedAt,"running",`回补 ${days} 日公告`).first<{id:number}>();
    let found = 0; let inserted = 0; let failures = 0; const dates: {date:string;found:number;inserted:number;error?:string}[] = [];
    for (let index = days - 1; index >= 0; index--) {
      const current = new Date(end); current.setUTCDate(end.getUTCDate() - index); const date = current.toISOString().slice(0,10); if (!isTradingDate(date)) continue;
      try { const result = await ingestCninfo(env.DB,date); found += result.found; inserted += result.inserted; dates.push({date,...result}); }
      catch (error) { failures++; dates.push({date,found:0,inserted:0,error:error instanceof Error ? error.message : "sync failed"}); }
    }
    await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,failures=?,message=? WHERE id=?").bind(new Date().toISOString(),failures ? "completed_with_errors" : "completed",found,failures,`回补 ${days} 日：发现 ${found} 条，新增 ${inserted} 条，失败日期 ${failures} 个`,run?.id).run();
    ctx.waitUntil(processPendingQueue(env.DB,env.DOCUMENTS,10,env));
    return json({ok:true,run_id:run?.id,days,end_date:endDate,announcements_found:found,announcements_inserted:inserted,failures,dates,auto_processing:true});
  }
  if (url.pathname === "/api/stock-coverage" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT a.stock_code AS stockCode,MAX(a.stock_name) AS stockName,COUNT(*) AS announcements,MIN(a.announce_date) AS firstDate,MAX(a.announce_date) AS latestDate,SUM(CASE WHEN a.parse_status='parsed' THEN 1 ELSE 0 END) AS parsedAnnouncements,COALESCE(p.events,0) AS events,COALESCE(p.firstDate,'') AS eventFirstDate,COALESCE(p.latestDate,'') AS eventLatestDate FROM announcement a LEFT JOIN (SELECT stock_code,COUNT(*) AS events,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate FROM pledge GROUP BY stock_code) p ON p.stock_code=a.stock_code GROUP BY a.stock_code ORDER BY announcements ASC,latestDate DESC LIMIT 200").all();
    return json({ data: result.results, generatedAt: new Date().toISOString(), scope: "公司级已抓取范围" });
  }
  if (url.pathname === "/api/coverage" && request.method === "GET") {
    const [announcement, events, stocks, pending, latestRun] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate,COUNT(DISTINCT stock_code) AS stockCount FROM announcement").first(),
      env.DB.prepare("SELECT COUNT(*) AS total,COUNT(DISTINCT stock_code) AS stockCount,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate FROM pledge").first(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM stock_info").first(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM announcement WHERE parse_status != 'parsed'").first(),
      env.DB.prepare("SELECT finished_at AS finishedAt,status FROM sync_run ORDER BY id DESC LIMIT 1").first(),
    ]);
    return json({ announcements: announcement, events, listedStocks: stocks, pending, latestRun, generatedAt: new Date().toISOString(), scope: "已抓取官方公告范围，不代表全市场全历史完整度" });
  }
  if (url.pathname === "/api/reconciliation" && request.method === "GET") {
    const requestedDate=url.searchParams.get("date");
    const latest=await env.DB.prepare("SELECT MAX(announce_date) AS date FROM exchange_observation").first<{date:string}>();
    const date=requestedDate&&/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)?requestedDate:latest?.date||shanghaiDate(-1);
    const [summary,rows,lastRun]=await Promise.all([
      env.DB.prepare("SELECT source,COUNT(*) AS observed,SUM(CASE WHEN match_status='exact' THEN 1 ELSE 0 END) AS exact,SUM(CASE WHEN match_status='likely' THEN 1 ELSE 0 END) AS likely,SUM(CASE WHEN match_status='ambiguous' THEN 1 ELSE 0 END) AS ambiguous,SUM(CASE WHEN match_status='missing_primary' THEN 1 ELSE 0 END) AS missingPrimary,SUM(CASE WHEN match_status='missing_primary' AND review_status='pending' THEN 1 ELSE 0 END) AS pendingReview,SUM(CASE WHEN review_status='promoted' THEN 1 ELSE 0 END) AS promoted,SUM(CASE WHEN review_status='rejected' THEN 1 ELSE 0 END) AS rejected,MAX(observed_at) AS observedAt FROM exchange_observation WHERE announce_date=? GROUP BY source ORDER BY source").bind(date).all(),
      env.DB.prepare("SELECT id,source,source_announcement_id AS sourceAnnouncementId,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,match_status AS matchStatus,match_method AS matchMethod,matched_announcement_id AS matchedAnnouncementId,review_status AS reviewStatus,reviewed_at AS reviewedAt,reviewed_by AS reviewedBy,review_note AS reviewNote,observed_at AS observedAt FROM exchange_observation WHERE announce_date=? ORDER BY CASE WHEN match_status='missing_primary' AND review_status='pending' THEN 0 WHEN match_status='ambiguous' THEN 1 WHEN match_status='likely' THEN 2 ELSE 3 END,source,stock_code LIMIT 300").bind(date).all(),
      env.DB.prepare("SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,announcements_found AS announcementsFound,failures,message FROM sync_run WHERE source='exchange-reconciliation' AND json_valid(message) AND json_extract(message,'$.date')=? ORDER BY id DESC LIMIT 1").bind(date).first<{id:number;startedAt:string;finishedAt?:string;status:string;announcementsFound:number;failures:number;message:string}>(),
    ]);
    const sourceRuns=(lastRun?JSON.parse(lastRun.message||"{}").results:[]) as {source:string;status:string;observed?:number;exact?:number;likely?:number;ambiguous?:number;missing?:number;error?:string;note?:string}[];
    const unresolved=summary.results.reduce((total,row)=>total+Number((row as Record<string,unknown>).pendingReview||0)+Number((row as Record<string,unknown>).ambiguous||0),0);
    const requiredSources=3;const successfulSources=sourceRuns.filter((result)=>result.status==="completed").length;
    const completenessStatus=!lastRun?"not_run":successfulSources===requiredSources&&unresolved===0?"verified":"incomplete";
    const completeness={status:completenessStatus,label:completenessStatus==="verified"?"三所对账完成：可声明当日公开披露清单完整":completenessStatus==="not_run"?"该日期尚未运行三所对账":"对账未闭环：暂不可声明全市场完整",unresolved,successfulSources,requiredSources};
    return json({date,summary:summary.results,rows:rows.results,lastRun,sourceRuns,completeness,capabilities:{sse:"支持指定日期全量分页",szse:"公开接口仅支持最近披露窗口",bse:"支持指定日期关键词核验"},scope:"独立观察与差异识别；只有三所均成功且未解决差异为零才通过完整性核验",generatedAt:new Date().toISOString()});
  }
  if (url.pathname === "/api/reconciliation/run" && request.method === "POST") {
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const input=await request.json<{date?:string;sources?:string[]}>().catch(()=>({}));
    const date=input.date||shanghaiDate(-1);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"无效对账日期"},{status:400});
    const sources=[...new Set((input.sources||["sse","szse","bse"]).filter((source)=>["sse","szse","bse"].includes(source)))];if(!sources.length)return json({error:"请选择至少一个交易所"},{status:400});
    const last=await env.DB.prepare("SELECT value,updated_at AS updatedAt FROM pipeline_state WHERE key='exchange_reconciliation_last'").first<{value:string;updatedAt:string}>();
    if(last&&Date.now()-Date.parse(last.updatedAt)<5*60*1000){const prior=JSON.parse(last.value||"{}");if(prior.date===date)return json({error:"同一日期刚刚完成对账，请五分钟后再试",lastRun:prior},{status:429});}
    const result=await runExchangeReconciliation(env.DB,date,sources);
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("exchange_reconciliation",date,"run",JSON.stringify(result),viewer,new Date().toISOString()).run();
    return json({ok:true,...result,scope:"对账结果不会自动进入正式事件库"});
  }
  const reconciliationAction=url.pathname.match(/^\/api\/reconciliation\/observations\/(\d+)\/(promote|reject)$/);
  if(reconciliationAction&&request.method==="POST"){
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const id=Number(reconciliationAction[1]);const action=reconciliationAction[2];
    try{
      if(action==="promote"){
        const result=await promoteExchangeObservation(env.DB,env.DOCUMENTS,id,viewer);
        if(result.status==="promoted"&&!result.idempotent){
          ctx.waitUntil(processAnnouncement(env.DB,env.DOCUMENTS,result.announcementId,env).catch(async(error)=>{
            const message=error instanceof Error?error.message:"parse failed";
            await env.DB.batch([
              env.DB.prepare("UPDATE announcement SET last_error=?,parse_attempts=parse_attempts+1 WHERE announcement_id=?").bind(message,result.announcementId),
              env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",result.announcementId,"background_parse_failed",JSON.stringify({message}),"worker",new Date().toISOString()),
            ]);
          }));
        }
        return json({ok:true,...result,autoProcessing:result.status==="promoted"});
      }
      const input=await request.json<{note?:string}>().catch(()=>({}));
      const note=(input.note||"人工判定无需补入主库").trim().slice(0,300);
      const row=await env.DB.prepare("SELECT id,match_status AS matchStatus,review_status AS reviewStatus FROM exchange_observation WHERE id=?").bind(id).first<{id:number;matchStatus:string;reviewStatus:string}>();
      if(!row)return json({error:"观察记录不存在"},{status:404});
      if(row.matchStatus!=="missing_primary"||row.reviewStatus!=="pending")return json({error:"该差异已经处理或不允许驳回"},{status:409});
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE exchange_observation SET review_status='rejected',reviewed_at=?,reviewed_by=?,review_note=? WHERE id=?").bind(now,viewer,note,id),
        env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("exchange_observation",String(id),"reject_missing_candidate",JSON.stringify({note}),viewer,now),
      ]);
      return json({ok:true,status:"rejected",id});
    }catch(error){return json({error:error instanceof Error?error.message:"差异处理失败"},{status:409});}
  }
  if(url.pathname==="/api/reconciliation/batch"&&request.method==="POST"){
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const input=await request.json<{ids?:number[];action?:"promote"|"reject";note?:string}>().catch(()=>({}));
    const ids=[...new Set((input.ids||[]).map(Number).filter((id)=>Number.isInteger(id)&&id>0))].slice(0,10);
    if(!ids.length||!["promote","reject"].includes(input.action||""))return json({error:"请选择 1 至 10 条待处理差异"},{status:400});
    const results:{id:number;status:string;announcementId?:string;error?:string}[]=[];let promoted=0;
    for(const id of ids){
      try{
        if(input.action==="promote"){
          const result=await promoteExchangeObservation(env.DB,env.DOCUMENTS,id,viewer);results.push({id,status:result.status,announcementId:result.announcementId});if(result.status==="promoted"&&!result.idempotent)promoted++;
        }else{
          const row=await env.DB.prepare("SELECT match_status AS matchStatus,review_status AS reviewStatus FROM exchange_observation WHERE id=?").bind(id).first<{matchStatus:string;reviewStatus:string}>();
          if(!row||row.matchStatus!=="missing_primary"||row.reviewStatus!=="pending")throw new Error("记录已经处理或不允许排除");
          const now=new Date().toISOString();const note=(input.note||"批量人工判定无需补入主库").trim().slice(0,300);
          await env.DB.batch([
            env.DB.prepare("UPDATE exchange_observation SET review_status='rejected',reviewed_at=?,reviewed_by=?,review_note=? WHERE id=?").bind(now,viewer,note,id),
            env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("exchange_observation",String(id),"batch_reject_missing_candidate",JSON.stringify({note}),viewer,now),
          ]);results.push({id,status:"rejected"});
        }
      }catch(error){results.push({id,status:"failed",error:error instanceof Error?error.message:"处理失败"});}
    }
    if(promoted)ctx.waitUntil(processPendingQueue(env.DB,env.DOCUMENTS,Math.min(promoted,10),env));
    return json({ok:true,requested:ids.length,succeeded:results.filter((item)=>item.status!=="failed").length,failed:results.filter((item)=>item.status==="failed").length,autoProcessing:promoted>0,results});
  }
  if(url.pathname==="/api/operations/daily"&&request.method==="GET"){
    await activeDailyProductionRun(env.DB);
    const [run,state,counts]=await Promise.all([
      env.DB.prepare("SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,announcements_found AS announcementsFound,events_created AS eventsCreated,failures,message FROM sync_run WHERE source='daily-production-cycle' ORDER BY id DESC LIMIT 1").first(),
      env.DB.prepare("SELECT value,updated_at AS updatedAt FROM pipeline_state WHERE key='daily_production_last'").first<{value:string;updatedAt:string}>(),
      env.DB.prepare("SELECT (SELECT COUNT(*) FROM exchange_observation WHERE match_status='missing_primary' AND review_status='pending') AS pendingDifferences,(SELECT COUNT(*) FROM announcement WHERE parse_status IN ('queued','archived') AND parse_attempts<3) AS retryableAnnouncements,(SELECT COUNT(*) FROM review_queue WHERE status='pending') AS pendingReviews").first(),
    ]);
    return json({run,lastResult:state?JSON.parse(state.value):null,lastUpdatedAt:state?.updatedAt||null,counts,recommendedDate:latestTradingDate(),scope:"同步巨潮质押公告、运行三所独立对账并处理待解析队列"});
  }
  if(url.pathname==="/api/operations/daily"&&request.method==="POST"){
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const input=await request.json<{date?:string}>().catch(()=>({}));const date=input.date||latestTradingDate();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!isTradingDate(date))return json({error:"请选择有效交易日"},{status:400});
    const active=await activeDailyProductionRun(env.DB,date);
    if(active)return json({error:"已有每日数据任务正在运行",runId:active.id,startedAt:active.startedAt},{status:409});
    const startedAt=new Date().toISOString();
    const run=await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("daily-production-cycle",startedAt,"running",`每日生产闭环 ${date}`).first<{id:number}>();
    if(!run?.id)return json({error:"无法创建每日数据任务"},{status:500});
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("daily_production",date,"started",JSON.stringify({runId:run.id}),viewer,startedAt).run();
    ctx.waitUntil(runDailyProductionCycle(env,date,run.id,viewer).catch(()=>undefined));
    return json({ok:true,accepted:true,runId:run.id,date,status:"running",scope:"后台同步、三所对账与解析已启动"},{status:202});
  }
  if(url.pathname==="/api/maintenance"&&request.method==="GET"){
    const [state,candidates,latestEvidenceRun]=await Promise.all([
      env.DB.prepare("SELECT value,updated_at AS updatedAt FROM pipeline_state WHERE key='data_maintenance_last'").first<{value:string;updatedAt:string}>(),
      env.DB.prepare("SELECT (SELECT COUNT(DISTINCT a.announcement_id) FROM announcement a JOIN pledge p ON p.announcement_id=a.announcement_id WHERE json_extract(p.evidence_json,'$.pageNumber') IS NULL AND (SELECT COUNT(*) FROM audit_log l WHERE l.entity_type='announcement' AND l.entity_id=a.announcement_id AND l.action='evidence_backfill_attempt')<2) AS evidenceCandidates,(SELECT COUNT(DISTINCT a.announcement_id) FROM announcement a JOIN review_queue r ON r.announcement_id=a.announcement_id AND r.status='pending' WHERE a.parse_status='review' AND a.parse_attempts<2 AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type='announcement' AND l.entity_id=a.announcement_id AND l.action='parser_upgrade_v2_4_attempt')) AS parserRetryCandidates").first<{evidenceCandidates:number;parserRetryCandidates:number}>(),
      env.DB.prepare("SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,announcements_found AS announcementsFound,events_created AS eventsLocated,failures,message FROM sync_run WHERE source='evidence-backfill' ORDER BY id DESC LIMIT 1").first(),
    ]);
    return json({lastResult:state?JSON.parse(state.value):null,lastUpdatedAt:state?.updatedAt||null,candidates,latestEvidenceRun,scope:"每天最多用v2.4重试3份待审核公告、处理5份PDF证据并向前回补1个交易日"});
  }
  if(url.pathname==="/api/maintenance"&&request.method==="POST"){
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const active=await env.DB.prepare("SELECT id,source,started_at AS startedAt FROM sync_run WHERE source IN ('evidence-backfill','historical-rolling-backfill') AND status='running' ORDER BY id DESC LIMIT 1").first();
    if(active)return json({error:"已有数据维护任务正在运行",active},{status:409});
    const now=new Date().toISOString();await env.DB.prepare("INSERT INTO pipeline_state (key,value,updated_at) VALUES ('automatic_maintenance_trigger',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify({reason:"manual",status:"running",viewer}),now).run();
    ctx.waitUntil(runMaintenanceCycle(env,"manual-quality-center").catch(()=>undefined));
    return json({ok:true,accepted:true,status:"running",scope:"正在补齐PDF页码证据并向前回补1个交易日"},{status:202});
  }
  if (url.pathname === "/api/data-quality" && request.method === "GET") {
    const since = addDays(shanghaiDate(),-45);
    const [announcements,events,latency,daily,sources,parsers,failures,runs,exchangeSources] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN parse_status='parsed' THEN 1 ELSE 0 END) AS parsed,SUM(CASE WHEN parse_status='review' THEN 1 ELSE 0 END) AS review,SUM(CASE WHEN parse_status IN ('queued','archived','pending') THEN 1 ELSE 0 END) AS waiting,SUM(CASE WHEN parse_status='ignored' THEN 1 ELSE 0 END) AS ignored,SUM(CASE WHEN pdf_url IS NOT NULL AND TRIM(pdf_url)!='' AND md5 IS NOT NULL AND TRIM(md5)!='' THEN 1 ELSE 0 END) AS traceable,SUM(CASE WHEN r2_key IS NOT NULL AND TRIM(r2_key)!='' THEN 1 ELSE 0 END) AS archived,COUNT(DISTINCT stock_code) AS stocks,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate,MAX(crawl_time) AS latestCrawlAt FROM announcement").first<Record<string,number|string|null>>(),
      env.DB.prepare("SELECT COUNT(*) AS total,COUNT(DISTINCT announcement_id) AS announcements,COUNT(DISTINCT stock_code) AS stocks,SUM(CASE WHEN TRIM(stock_code)!='' AND TRIM(stock_name)!='' AND TRIM(shareholder)!='' AND TRIM(pledgee)!='' AND pledge_amount>0 AND TRIM(type)!='' AND TRIM(announce_date)!='' THEN 1 ELSE 0 END) AS requiredComplete,SUM(CASE WHEN pledge_ratio IS NOT NULL AND TRIM(pledge_ratio)!='' THEN 1 ELSE 0 END) AS withPledgeRatio,SUM(CASE WHEN total_ratio IS NOT NULL AND TRIM(total_ratio)!='' THEN 1 ELSE 0 END) AS withTotalRatio,SUM(CASE WHEN start_date IS NOT NULL AND TRIM(start_date)!='' THEN 1 ELSE 0 END) AS withStartDate,SUM(CASE WHEN end_date IS NOT NULL AND TRIM(end_date)!='' THEN 1 ELSE 0 END) AS withEndDate,SUM(CASE WHEN purpose IS NOT NULL AND TRIM(purpose)!='' THEN 1 ELSE 0 END) AS withPurpose,SUM(CASE WHEN verification_status='human_verified' THEN 1 ELSE 0 END) AS humanVerified,SUM(CASE WHEN verification_status='ai_reviewed' THEN 1 ELSE 0 END) AS aiReviewed,SUM(CASE WHEN verification_status='rules_validated' THEN 1 ELSE 0 END) AS rulesValidated,SUM(CASE WHEN json_extract(evidence_json,'$.pageNumber') IS NOT NULL THEN 1 ELSE 0 END) AS withEvidence,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate,MAX(parsed_at) AS latestParsedAt FROM pledge").first<Record<string,number|string|null>>(),
      env.DB.prepare("SELECT AVG((julianday(p.parsedAt)-julianday(a.crawl_time))*1440.0) AS averageMinutes,MAX((julianday(p.parsedAt)-julianday(a.crawl_time))*1440.0) AS maximumMinutes,COUNT(*) AS samples FROM announcement a JOIN (SELECT announcement_id,MIN(parsed_at) AS parsedAt FROM pledge GROUP BY announcement_id) p ON p.announcement_id=a.announcement_id WHERE julianday(p.parsedAt)>=julianday(a.crawl_time)").first<Record<string,number|null>>(),
      env.DB.prepare("SELECT a.date,a.announcements,a.parsed,a.review,a.ignored,COALESCE(p.events,0) AS events FROM (SELECT announce_date AS date,COUNT(*) AS announcements,SUM(CASE WHEN parse_status='parsed' THEN 1 ELSE 0 END) AS parsed,SUM(CASE WHEN parse_status='review' THEN 1 ELSE 0 END) AS review,SUM(CASE WHEN parse_status='ignored' THEN 1 ELSE 0 END) AS ignored FROM announcement WHERE announce_date>=? GROUP BY announce_date) a LEFT JOIN (SELECT announce_date AS date,COUNT(*) AS events FROM pledge WHERE announce_date>=? GROUP BY announce_date) p ON p.date=a.date ORDER BY a.date DESC").bind(since,since).all(),
      env.DB.prepare("SELECT source,COUNT(*) AS announcements,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate,SUM(CASE WHEN parse_status='parsed' THEN 1 ELSE 0 END) AS parsed FROM announcement GROUP BY source ORDER BY announcements DESC").all(),
      env.DB.prepare("SELECT parser_version AS parserVersion,COUNT(*) AS events,COUNT(DISTINCT announcement_id) AS announcements,ROUND(AVG(confidence)*100,1) AS averageConfidence FROM pledge GROUP BY parser_version ORDER BY events DESC").all(),
      env.DB.prepare("SELECT announcement_id AS announcementId,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,parse_status AS parseStatus,parse_attempts AS parseAttempts,last_error AS lastError,pdf_url AS pdfUrl FROM announcement WHERE parse_status NOT IN ('parsed','ignored') OR last_error IS NOT NULL ORDER BY parse_attempts DESC,announce_date DESC LIMIT 30").all(),
      env.DB.prepare("SELECT id,source,started_at AS startedAt,finished_at AS finishedAt,status,announcements_found AS announcementsFound,events_created AS eventsCreated,failures,message FROM sync_run ORDER BY id DESC LIMIT 12").all(),
      env.DB.prepare("SELECT source,COUNT(*) AS observations,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate,MAX(observed_at) AS observedAt FROM exchange_observation GROUP BY source ORDER BY source").all(),
    ]);
    const announcementStats = announcements || {};
    const eventStats = events || {};
    const eligible = Math.max(Number(announcementStats.total||0)-Number(announcementStats.ignored||0),0);
    const parseRate = eligible ? Number(announcementStats.parsed||0)/eligible : 0;
    const traceabilityRate = Number(announcementStats.total||0) ? Number(announcementStats.traceable||0)/Number(announcementStats.total) : 0;
    const requiredFieldRate = Number(eventStats.total||0) ? Number(eventStats.requiredComplete||0)/Number(eventStats.total) : 0;
    const latestRun = runs.results[0] as {startedAt?:string;finishedAt?:string}|undefined;
    const latestRunAt = latestRun?.finishedAt || latestRun?.startedAt || null;
    const freshnessHours = latestRunAt ? Math.max(0,(Date.now()-Date.parse(latestRunAt))/3600000) : null;
    const freshnessFactor = freshnessHours==null ? 0 : freshnessHours<=30 ? 1 : freshnessHours<=54 ? .7 : freshnessHours<=78 ? .3 : 0;
    const score = Math.round((parseRate*.4+traceabilityRate*.25+requiredFieldRate*.2+freshnessFactor*.15)*100);
    const observedDates = new Set((daily.results as {date:string}[]).map((row)=>row.date));
    const missingTradingDateCandidates:string[]=[];
    for(let offset=0;offset<31;offset++){const date=addDays(shanghaiDate(),-offset);if(isTradingDate(date)&&!observedDates.has(date))missingTradingDateCandidates.push(date);}
    return json({
      score,grade:score>=90?"稳定":score>=75?"可用，仍需补齐":score>=60?"需重点复核":"尚未达到研究标准",
      metrics:{parseRate,traceabilityRate,requiredFieldRate,freshnessHours,latencyMinutes:latency||{}},
      announcements:announcementStats,events:eventStats,daily:daily.results,sources:sources.results,exchangeSources:exchangeSources.results,parsers:parsers.results,failures:failures.results,runs:runs.results,
      gapCandidates:missingTradingDateCandidates,
      crossSource:{status:exchangeSources.results.length?"observed-multiple-sources":"single-primary-source",note:exchangeSources.results.length?"已保存交易所独立观察记录，但差异仍需人工确认；这不等于全市场完成性证明。":"当前只统计主公告库来源；交易所交叉补漏尚未形成完成性证明。"},
      generatedAt:new Date().toISOString(),scope:"生产质量评分，不等同于全市场历史覆盖率或数据正确率承诺",
    });
  }
  if (url.pathname === "/api/feed" && request.method === "GET") {
    const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 24, 1), 168);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const result = await env.DB.prepare("SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,a.crawl_time AS crawledAt,a.title,a.source,a.pdf_url AS pdfUrl,p.confidence,p.parser_version AS parserVersion,p.verification_status AS verificationStatus,p.verified_at AS verifiedAt,p.verified_by AS verifiedBy,p.evidence_json AS evidenceJson FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id WHERE a.crawl_time >= ? ORDER BY a.crawl_time DESC,p.id DESC LIMIT ?").bind(since, limit).all();
    return json({ data: result.results, hours, limit, since, generatedAt: new Date().toISOString(), freshness: "official-announcement-crawl" });
  }
  if (url.pathname === "/api/capital-signals" && request.method === "GET") {
    type CapitalEvent = { id:number;announcementId:string;code:string;name:string;shareholder:string;pledgee:string;amount:number;amountText:string;ratio:string;total:string;type:string;date:string;pdfUrl:string;source:string };
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 365, 30), 3650);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 10), 300);
    const since = addDays(shanghaiDate(), -days);
    const result = await env.DB.prepare("SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount AS amount,p.pledge_amount_text AS amountText,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,a.pdf_url AS pdfUrl,a.source FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id WHERE p.announce_date>=? ORDER BY p.announce_date DESC,p.id DESC LIMIT 5000").bind(since).all<CapitalEvent>();
    const rows = result.results;
    const pct = (value:string) => Number(String(value || "").replace(/[^0-9.]/g,"")) || 0;
    const actorMap = new Map<string,{code:string;name:string;shareholder:string;events:CapitalEvent[]}>();
    const relationMap = new Map<string,{shareholder:string;pledgee:string;events:CapitalEvent[];companies:Set<string>}>();
    for (const row of rows) {
      const actorKey = `${row.code}\u0000${row.shareholder}`;
      const actor = actorMap.get(actorKey) || { code:row.code,name:row.name,shareholder:row.shareholder,events:[] };
      actor.events.push(row); actorMap.set(actorKey,actor);
      const relationKey = `${row.shareholder}\u0000${row.pledgee}`;
      const relation = relationMap.get(relationKey) || { shareholder:row.shareholder,pledgee:row.pledgee,events:[],companies:new Set<string>() };
      relation.events.push(row); relation.companies.add(row.code); relationMap.set(relationKey,relation);
    }
    const recent30Cutoff = addDays(shanghaiDate(),-30);
    const actors = [...actorMap.values()].map((actor) => {
      const pledgeEvents = actor.events.filter((row) => !row.type.includes("解除"));
      const releases = actor.events.filter((row) => row.type.includes("解除")).length;
      const supplemental = actor.events.filter((row) => row.type.includes("补充")).length;
      const recent30 = actor.events.filter((row) => row.date >= recent30Cutoff).length;
      const highRatio = actor.events.filter((row) => Math.max(pct(row.ratio),pct(row.total)) >= 50).length;
      const pledgeeCounts = new Map<string,number>();
      for (const row of pledgeEvents) pledgeeCounts.set(row.pledgee,(pledgeeCounts.get(row.pledgee) || 0) + 1);
      const rankedPledgees = [...pledgeeCounts.entries()].sort((a,b) => b[1]-a[1]);
      const topPledgee = rankedPledgees[0]?.[0] || "—";
      const topPledgeeEvents = rankedPledgees[0]?.[1] || 0;
      const concentration = pledgeEvents.length ? Math.round(topPledgeeEvents / pledgeEvents.length * 100) : 0;
      const eventGap = Math.max(0,pledgeEvents.length-releases);
      const activityScore = Math.min(100,supplemental*20+recent30*6+eventGap*3+highRatio*8+(topPledgeeEvents>=3?10:0));
      const signals:string[] = [];
      if (supplemental) signals.push(`补充质押 ${supplemental} 次`);
      if (recent30 >= 2) signals.push(`近30日发生 ${recent30} 次`);
      if (eventGap >= 2) signals.push(`质押事件较解除事件多 ${eventGap} 条`);
      if (topPledgeeEvents >= 3) signals.push(`同一质权人重复出现 ${topPledgeeEvents} 次`);
      if (highRatio) signals.push(`高比例披露 ${highRatio} 条`);
      return { ...actor,events:actor.events.length,pledgeEvents:pledgeEvents.length,releases,supplemental,recent30,highRatio,eventGap,pledgeeCount:pledgeeCounts.size,topPledgee,topPledgeeEvents,concentration,totalAmount:pledgeEvents.reduce((sum,row)=>sum+(Number(row.amount)||0),0),latestDate:actor.events[0]?.date,firstDate:actor.events[actor.events.length-1]?.date,activityScore,level:activityScore>=60?"优先跟进":activityScore>=30?"持续观察":"常规",signals,evidence:actor.events.slice(0,5).map((row)=>({id:row.id,announcementId:row.announcementId,date:row.date,type:row.type,pdfUrl:row.pdfUrl})) };
    }).sort((a,b) => b.activityScore-a.activityScore || b.recent30-a.recent30).slice(0,limit);
    const relationships = [...relationMap.values()].map((relation) => ({ shareholder:relation.shareholder,pledgee:relation.pledgee,events:relation.events.length,companies:relation.companies.size,latestDate:relation.events[0]?.date,totalAmount:relation.events.filter((row)=>!row.type.includes("解除")).reduce((sum,row)=>sum+(Number(row.amount)||0),0),supplemental:relation.events.filter((row)=>row.type.includes("补充")).length,releases:relation.events.filter((row)=>row.type.includes("解除")).length,companyCodes:[...relation.companies] })).sort((a,b)=>b.events-a.events || b.totalAmount-a.totalAmount).slice(0,limit);
    return json({ data:{ actors,relationships },coverage:{ since,firstDate:rows[rows.length-1]?.date || null,latestDate:rows[0]?.date || null,events:rows.length },generatedAt:new Date().toISOString(),methodology:{ activityScore:"补充质押、近30日活跃度、质押与解除事件差、高比例披露及重复质权人信号的规则评分",eventGap:"质押类事件数量减解除类事件数量；不是当前存量质押股数",limitations:"仅基于已抓取并通过校验的官方公告，不代表全市场全历史完整度或授信结论" } });
  }
  if (url.pathname === "/api/profile" && request.method === "GET") {
    const stock = (url.searchParams.get("stock") || "").trim();
    if (!stock) return json({ error: "stock is required" }, { status: 400 });
    const [summary, types, shareholders, history] = await Promise.all([
      env.DB.prepare("SELECT p.stock_code AS stock,p.stock_name AS name,COUNT(*) AS events,COALESCE(SUM(CASE WHEN p.type LIKE '%解除%' THEN 0 ELSE p.pledge_amount END),0) AS pledged_amount,MAX(p.announce_date) AS latest_date FROM pledge p WHERE p.stock_code=? GROUP BY p.stock_code,p.stock_name").bind(stock).first(),
      env.DB.prepare("SELECT type,COUNT(*) AS count FROM pledge WHERE stock_code=? GROUP BY type ORDER BY count DESC").bind(stock).all(),
      env.DB.prepare("SELECT shareholder,COUNT(*) AS events,COALESCE(SUM(pledge_amount),0) AS amount,MAX(announce_date) AS latest_date FROM pledge WHERE stock_code=? GROUP BY shareholder ORDER BY amount DESC LIMIT 20").bind(stock).all(),
      env.DB.prepare("SELECT announce_date AS date,type,pledge_amount_text AS amount,pledge_ratio AS ratio,total_ratio AS total,shareholder,pledgee,announcement_id AS announcementId FROM pledge WHERE stock_code=? ORDER BY announce_date DESC,id DESC LIMIT 100").bind(stock).all(),
    ]);
    return json({ stock, summary: summary || null, types: types.results, shareholders: shareholders.results, history: history.results, generatedAt: new Date().toISOString(), traceable: true });
  }
  if (url.pathname === "/api/shareholder-profiles" && (request.method === "GET" || request.method === "PUT")) {
    const stock = (url.searchParams.get("stock") || "").trim();
    if (!/^\d{6}$/.test(stock)) return json({ error: "invalid-stock" }, { status: 400 });
    if (request.method === "GET") {
      const rows = await env.DB.prepare("SELECT stock_code AS stockCode,shareholder,identity_type AS identityType,is_controller AS isController,is_controlling_shareholder AS isControllingShareholder,holding_shares AS holdingShares,holding_ratio AS holdingRatio,source_title AS sourceTitle,source_url AS sourceUrl,source_date AS sourceDate,confidence,updated_at AS updatedAt,updated_by AS updatedBy FROM shareholder_profile WHERE stock_code=? ORDER BY is_controller DESC,is_controlling_shareholder DESC,updated_at DESC").bind(stock).all();
      return json({ data: rows.results, stock, traceable: true });
    }
    const userId = adminViewer(request,env);
    if (!userId) return adminRequired();
    const input = await request.json<{shareholder?:string;identityType?:string;holdingShares?:number|null;holdingRatio?:string;sourceTitle?:string;sourceUrl?:string;sourceDate?:string}>().catch(() => ({}));
    const shareholder = String(input.shareholder || "").trim();
    if (!shareholder || shareholder.length > 120) return json({ error: "invalid-shareholder" }, { status: 400 });
    const identityType = String(input.identityType || "股东").trim();
    const isController = identityType === "实际控制人" ? 1 : 0;
    const isControllingShareholder = identityType === "控股股东" ? 1 : 0;
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO shareholder_profile (stock_code,shareholder,identity_type,is_controller,is_controlling_shareholder,holding_shares,holding_ratio,source_title,source_url,source_date,confidence,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stock_code,shareholder) DO UPDATE SET identity_type=excluded.identity_type,is_controller=excluded.is_controller,is_controlling_shareholder=excluded.is_controlling_shareholder,holding_shares=excluded.holding_shares,holding_ratio=excluded.holding_ratio,source_title=excluded.source_title,source_url=excluded.source_url,source_date=excluded.source_date,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(stock,shareholder,identityType,isController,isControllingShareholder,input.holdingShares == null ? null : Number(input.holdingShares),String(input.holdingRatio || "").trim() || null,String(input.sourceTitle || "").trim() || null,String(input.sourceUrl || "").trim() || null,String(input.sourceDate || "").trim() || null,1,now,userId).run();
    const row = await env.DB.prepare("SELECT stock_code AS stockCode,shareholder,identity_type AS identityType,is_controller AS isController,is_controlling_shareholder AS isControllingShareholder,holding_shares AS holdingShares,holding_ratio AS holdingRatio,source_title AS sourceTitle,source_url AS sourceUrl,source_date AS sourceDate,confidence,updated_at AS updatedAt,updated_by AS updatedBy FROM shareholder_profile WHERE stock_code=? AND shareholder=?").bind(stock,shareholder).first();
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("shareholder_profile",`${stock}:${shareholder}`,"upsert",JSON.stringify(row),userId,now).run();
    return json({ data: row, stock, traceable: true });
  }
  if (url.pathname === "/api/watchlist" && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
    const userId = viewerId(request);
    if (!userId) return json({ error: "sign-in-required", source: "device" }, { status: 401 });
    if (request.method === "GET") {
      const rows = await env.DB.prepare("SELECT stock_code AS stockCode FROM user_watchlist WHERE user_id=? ORDER BY created_at DESC").bind(userId).all<{stockCode:string}>();
      return json({ data: rows.results.map((row) => row.stockCode), source: "cloud" });
    }
    const input = await request.json<{stock?:string}>().catch(() => ({}));
    const stock = String(input.stock || "").trim();
    if (!/^\d{6}$/.test(stock)) return json({ error: "invalid-stock" }, { status: 400 });
    if (request.method === "PUT") await env.DB.prepare("INSERT OR IGNORE INTO user_watchlist (user_id,stock_code,created_at) VALUES (?,?,?)").bind(userId,stock,new Date().toISOString()).run();
    else await env.DB.prepare("DELETE FROM user_watchlist WHERE user_id=? AND stock_code=?").bind(userId,stock).run();
    const rows = await env.DB.prepare("SELECT stock_code AS stockCode FROM user_watchlist WHERE user_id=? ORDER BY created_at DESC").bind(userId).all<{stockCode:string}>();
    return json({ data: rows.results.map((row) => row.stockCode), source: "cloud" });
  }
  if (url.pathname === "/api/subscribe-interest" && request.method === "POST") {
    const input = await request.json<{email?: string; plan?: string}>().catch(() => ({}));
    const email = String(input.email || "").trim().toLowerCase(); const plan = String(input.plan || "pro").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "请输入有效邮箱" }, { status: 400 });
    if (!["pro", "enterprise"].includes(plan)) return json({ error: "无效套餐" }, { status: 400 });
    await env.DB.prepare("INSERT OR IGNORE INTO subscription_interest (email,plan,source,created_at) VALUES (?,?,?,?)").bind(email,plan,"pricing-modal",new Date().toISOString()).run();
    return json({ ok: true, message: "已登记，我们会在产品开放订阅后联系你" });
  }
  if (url.pathname === "/api/match-market" && request.method === "GET") {
    const [roles,total] = await Promise.all([
      env.DB.prepare("SELECT role,COUNT(*) AS count FROM match_request WHERE status IN ('new','active','matched') GROUP BY role").all(),
      env.DB.prepare("SELECT COUNT(*) AS total,MAX(created_at) AS latestAt FROM match_request WHERE status IN ('new','active','matched')").first(),
    ]);
    return json({ data:{ roles:roles.results,total },privacy:"仅返回匿名汇总，不公开联系人、融资主体或资金方信息",generatedAt:new Date().toISOString() });
  }
  if (url.pathname === "/api/match-requests" && request.method === "GET") {
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后查看撮合需求"},{status:401});
    const rows = await env.DB.prepare("SELECT r.id,r.role,r.organization,r.contact_name AS contactName,r.email,r.stock_code AS stockCode,r.shareholder,r.amount_min AS amountMin,r.amount_max AS amountMax,r.term_months AS termMonths,r.preference,r.purpose,r.status,r.created_at AS createdAt,(SELECT COUNT(*) FROM match_candidate m WHERE m.capital_request_id=r.id OR m.financing_request_id=r.id) AS candidateCount,(SELECT COUNT(*) FROM match_candidate m WHERE (m.capital_request_id=r.id OR m.financing_request_id=r.id) AND m.capital_consented=1 AND m.financing_consented=1) AS readyCount FROM match_request r WHERE r.viewer_id=? ORDER BY r.created_at DESC LIMIT 100").bind(viewer).all();
    return json({data:rows.results,ownership:"仅返回当前登录用户提交的需求"});
  }
  if (url.pathname === "/api/match-funnel" && request.method === "GET") {
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后查看转化漏斗"},{status:401});
    const [requests,funnel] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status!='closed' THEN 1 ELSE 0 END) AS open,SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed FROM match_request WHERE viewer_id=?").bind(viewer).first(),
      env.DB.prepare("SELECT COUNT(*) AS candidates,SUM(CASE WHEN m.capital_consented=1 AND m.financing_consented=1 THEN 1 ELSE 0 END) AS connected,SUM(CASE WHEN (c.viewer_id=? AND m.capital_stage='contacted') OR (f.viewer_id=? AND m.financing_stage='contacted') THEN 1 ELSE 0 END) AS contacted,SUM(CASE WHEN (c.viewer_id=? AND m.capital_stage='due_diligence') OR (f.viewer_id=? AND m.financing_stage='due_diligence') THEN 1 ELSE 0 END) AS dueDiligence,SUM(CASE WHEN (c.viewer_id=? AND m.capital_stage='negotiating') OR (f.viewer_id=? AND m.financing_stage='negotiating') THEN 1 ELSE 0 END) AS negotiating,SUM(CASE WHEN (c.viewer_id=? AND m.capital_stage='completed') OR (f.viewer_id=? AND m.financing_stage='completed') THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN (c.viewer_id=? AND m.capital_stage='declined') OR (f.viewer_id=? AND m.financing_stage='declined') THEN 1 ELSE 0 END) AS declined FROM match_candidate m JOIN match_request c ON c.id=m.capital_request_id JOIN match_request f ON f.id=m.financing_request_id WHERE c.viewer_id=? OR f.viewer_id=?").bind(viewer,viewer,viewer,viewer,viewer,viewer,viewer,viewer,viewer,viewer,viewer,viewer).first(),
    ]);
    return json({data:{requests:requests||{},funnel:funnel||{}},definition:"阶段由当前账户主动更新，双向确认后才计入已连接"});
  }
  if (url.pathname === "/api/matches" && request.method === "GET") {
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后查看匹配候选"},{status:401});
    type MatchCandidateRow = { id:number;score:number;reasons:string;status:string;capitalConsented:number;financingConsented:number;capitalStage:string;financingStage:string;capitalId:number;financingId:number;capitalViewer:string;financingViewer:string;capitalOrganization:string;capitalContact:string;capitalEmail:string;capitalAmountMin:number;capitalAmountMax:number;capitalTerm:number|null;capitalPreference:string|null;financingOrganization:string;financingContact:string;financingEmail:string;financingStockCode:string|null;financingShareholder:string|null;financingAmountMin:number;financingAmountMax:number;financingTerm:number|null;financingPurpose:string|null;financingRiskSnapshot:string|null;updatedAt:string };
    const result = await env.DB.prepare("SELECT m.id,m.score,m.reasons,m.status,m.capital_consented AS capitalConsented,m.financing_consented AS financingConsented,m.capital_stage AS capitalStage,m.financing_stage AS financingStage,m.capital_request_id AS capitalId,m.financing_request_id AS financingId,c.viewer_id AS capitalViewer,f.viewer_id AS financingViewer,c.organization AS capitalOrganization,c.contact_name AS capitalContact,c.email AS capitalEmail,c.amount_min AS capitalAmountMin,c.amount_max AS capitalAmountMax,c.term_months AS capitalTerm,c.preference AS capitalPreference,f.organization AS financingOrganization,f.contact_name AS financingContact,f.email AS financingEmail,f.stock_code AS financingStockCode,f.shareholder AS financingShareholder,f.amount_min AS financingAmountMin,f.amount_max AS financingAmountMax,f.term_months AS financingTerm,f.purpose AS financingPurpose,f.risk_snapshot AS financingRiskSnapshot,m.updated_at AS updatedAt FROM match_candidate m JOIN match_request c ON c.id=m.capital_request_id JOIN match_request f ON f.id=m.financing_request_id WHERE c.viewer_id=? OR f.viewer_id=? ORDER BY CASE WHEN m.capital_consented=1 AND m.financing_consented=1 THEN 0 ELSE 1 END,m.score DESC,m.updated_at DESC LIMIT 200").bind(viewer,viewer).all<MatchCandidateRow>();
    const data = result.results.map((row) => {
      const side = row.capitalViewer===viewer ? "capital" : "financing";
      const bothConsented = Boolean(row.capitalConsented && row.financingConsented);
      const ownConsented = side==="capital" ? Boolean(row.capitalConsented) : Boolean(row.financingConsented);
      const counterpart = side==="capital" ? { role:"financing",amountMin:row.financingAmountMin,amountMax:row.financingAmountMax,termMonths:row.financingTerm,summary:"A股上市公司股东融资项目",riskContextAttached:Boolean(row.financingRiskSnapshot),purpose:row.financingPurpose } : { role:"capital",amountMin:row.capitalAmountMin,amountMax:row.capitalAmountMax,termMonths:row.capitalTerm,summary:"机构资金方",riskContextAttached:false,preference:row.capitalPreference };
      const contact = bothConsented ? (side==="capital" ? {organization:row.financingOrganization,contactName:row.financingContact,email:row.financingEmail,stockCode:row.financingStockCode,shareholder:row.financingShareholder} : {organization:row.capitalOrganization,contactName:row.capitalContact,email:row.capitalEmail}) : null;
      return {id:row.id,score:row.score,reasons:JSON.parse(row.reasons || "[]"),status:row.status,side,ownStage:side==="capital"?row.capitalStage:row.financingStage,counterpartStage:bothConsented?(side==="capital"?row.financingStage:row.capitalStage):null,ownConsented,counterpartConsented:side==="capital"?Boolean(row.financingConsented):Boolean(row.capitalConsented),bothConsented,counterpart,contact,updatedAt:row.updatedAt};
    });
    return json({data,privacy:"双方分别确认前不返回对方机构、联系人、邮箱或融资主体身份"});
  }
  if (url.pathname.startsWith("/api/matches/") && url.pathname.endsWith("/consent") && request.method === "POST") {
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后确认撮合意向"},{status:401});
    const id = Number(url.pathname.split("/")[3]);
    if (!Number.isInteger(id)||id<=0) return json({error:"无效匹配编号"},{status:400});
    const row = await env.DB.prepare("SELECT m.id,m.status,c.viewer_id AS capitalViewer,f.viewer_id AS financingViewer FROM match_candidate m JOIN match_request c ON c.id=m.capital_request_id JOIN match_request f ON f.id=m.financing_request_id WHERE m.id=?").bind(id).first<{id:number;status:string;capitalViewer:string;financingViewer:string}>();
    if (!row || (row.capitalViewer!==viewer && row.financingViewer!==viewer)) return json({error:"无权操作该匹配"},{status:403});
    if (["closed","declined","completed"].includes(row.status)) return json({error:"该匹配已结束，不能再次确认"},{status:409});
    const now = new Date().toISOString();
    if (row.capitalViewer===viewer) await env.DB.prepare("UPDATE match_candidate SET capital_consented=1,capital_consented_at=?,updated_at=? WHERE id=?").bind(now,now,id).run();
    else await env.DB.prepare("UPDATE match_candidate SET financing_consented=1,financing_consented_at=?,updated_at=? WHERE id=?").bind(now,now,id).run();
    await env.DB.prepare("UPDATE match_candidate SET status=CASE WHEN capital_consented=1 AND financing_consented=1 THEN 'ready_to_connect' ELSE 'awaiting_counterparty' END,updated_at=? WHERE id=?").bind(now,id).run();
    const updated = await env.DB.prepare("SELECT status,capital_consented AS capitalConsented,financing_consented AS financingConsented FROM match_candidate WHERE id=?").bind(id).first();
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("match_candidate",String(id),"consent",JSON.stringify(updated),viewer,now).run();
    return json({ok:true,data:updated,message:(updated as {status?:string})?.status==='ready_to_connect'?"双方已确认，可以查看对接信息":"已记录你的意向，等待对方确认"});
  }
  if (url.pathname.startsWith("/api/matches/") && url.pathname.endsWith("/stage") && request.method === "PATCH") {
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后更新对接阶段"},{status:401});
    const id = Number(url.pathname.split("/")[3]);
    const input = await request.json<{stage?:string}>().catch(() => ({}));
    const stage = String(input.stage||"");
    if (!Number.isInteger(id)||id<=0 || !matchStages.has(stage)) return json({error:"无效匹配编号或阶段"},{status:400});
    const row = await env.DB.prepare("SELECT m.id,m.status,m.capital_consented AS capitalConsented,m.financing_consented AS financingConsented,m.capital_stage AS capitalStage,m.financing_stage AS financingStage,c.viewer_id AS capitalViewer,f.viewer_id AS financingViewer FROM match_candidate m JOIN match_request c ON c.id=m.capital_request_id JOIN match_request f ON f.id=m.financing_request_id WHERE m.id=?").bind(id).first<{id:number;status:string;capitalConsented:number;financingConsented:number;capitalStage:string;financingStage:string;capitalViewer:string;financingViewer:string}>();
    if (!row || (row.capitalViewer!==viewer && row.financingViewer!==viewer)) return json({error:"无权操作该匹配"},{status:403});
    if (row.status==="closed") return json({error:"该匹配已关闭"},{status:409});
    if (stage!=="declined" && !(row.capitalConsented&&row.financingConsented)) return json({error:"双方确认后才能更新对接阶段"},{status:409});
    const now = new Date().toISOString();
    const column = row.capitalViewer===viewer ? "capital_stage" : "financing_stage";
    await env.DB.prepare(`UPDATE match_candidate SET ${column}=?,updated_at=? WHERE id=?`).bind(stage,now,id).run();
    await env.DB.prepare("UPDATE match_candidate SET status=CASE WHEN capital_stage='declined' OR financing_stage='declined' THEN 'declined' WHEN capital_stage='completed' AND financing_stage='completed' THEN 'completed' WHEN capital_stage!='reviewing' OR financing_stage!='reviewing' THEN 'in_progress' ELSE 'ready_to_connect' END,updated_at=? WHERE id=?").bind(now,id).run();
    const updated = await env.DB.prepare("SELECT status,capital_stage AS capitalStage,financing_stage AS financingStage FROM match_candidate WHERE id=?").bind(id).first();
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,before_json,after_json,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind("match_candidate",String(id),"stage_updated",JSON.stringify({capitalStage:row.capitalStage,financingStage:row.financingStage}),JSON.stringify(updated),viewer,now).run();
    return json({ok:true,data:updated,message:"对接阶段已更新"});
  }
  if (url.pathname.startsWith("/api/match-requests/") && request.method === "PATCH") {
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后管理需求"},{status:401});
    const id = Number(url.pathname.split("/")[3]);
    const input = await request.json<{status?:string}>().catch(() => ({}));
    if (!Number.isInteger(id)||id<=0 || input.status!=="closed") return json({error:"只支持关闭有效需求"},{status:400});
    const row = await env.DB.prepare("SELECT id,status FROM match_request WHERE id=? AND viewer_id=?").bind(id,viewer).first<{id:number;status:string}>();
    if (!row) return json({error:"需求不存在或无权操作"},{status:404});
    if (row.status==="closed") return json({ok:true,message:"需求已经关闭"});
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE match_request SET status='closed' WHERE id=? AND viewer_id=?").bind(id,viewer),
      env.DB.prepare("UPDATE match_candidate SET status='closed',updated_at=? WHERE (capital_request_id=? OR financing_request_id=?) AND status NOT IN ('completed','declined')").bind(now,id,id),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,before_json,after_json,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind("match_request",String(id),"closed",JSON.stringify({status:row.status}),JSON.stringify({status:"closed"}),viewer,now),
    ]);
    return json({ok:true,message:"需求已关闭，相关未完成候选不再推进"});
  }
  if (url.pathname === "/api/match-requests" && request.method === "POST") {
    type MatchInput = { role?:string;organization?:string;contactName?:string;email?:string;stockCode?:string;shareholder?:string;amountMin?:number;amountMax?:number;termMonths?:number;preference?:string;purpose?:string;notes?:string;consent?:boolean };
    const viewer = viewerId(request);
    if (!viewer) return json({error:"请先登录后提交撮合需求"},{status:401});
    const input = await request.json<MatchInput>().catch(() => ({}));
    const role = String(input.role || "").trim();
    const organization = String(input.organization || "").trim();
    const contactName = String(input.contactName || "").trim();
    const email = String(input.email || request.headers.get("oai-authenticated-user-email") || "").trim().toLowerCase();
    const stockCode = String(input.stockCode || "").trim();
    const shareholder = String(input.shareholder || "").trim();
    const amountMin = Number(input.amountMin) * 10000;
    const amountMax = Number(input.amountMax) * 10000;
    const termMonths = input.termMonths == null ? null : Math.round(Number(input.termMonths));
    const preference = String(input.preference || "").trim();
    const purpose = String(input.purpose || "").trim();
    const notes = String(input.notes || "").trim();
    if (!['capital','financing','advisor'].includes(role)) return json({error:"请选择正确的身份"},{status:400});
    if (!organization || organization.length>120 || !contactName || contactName.length>60) return json({error:"请填写机构和联系人"},{status:400});
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>160) return json({error:"请填写有效联系邮箱"},{status:400});
    if (!Number.isFinite(amountMin) || !Number.isFinite(amountMax) || amountMin<=0 || amountMax<amountMin || amountMax>100000000000) return json({error:"请填写有效金额范围"},{status:400});
    if (termMonths != null && (!Number.isFinite(termMonths) || termMonths<1 || termMonths>120)) return json({error:"期限应为 1 至 120 个月"},{status:400});
    if ((role==='financing'||role==='advisor') && !/^\d{6}$/.test(stockCode)) return json({error:"融资需求必须填写六位股票代码"},{status:400});
    if ((role==='financing'||role==='advisor') && (!shareholder || shareholder.length>120)) return json({error:"请填写融资股东名称"},{status:400});
    if (!input.consent) return json({error:"提交前需同意隐私与人工撮合说明"},{status:400});
    if (preference.length>300 || purpose.length>200 || notes.length>1000) return json({error:"补充说明过长"},{status:400});
    const recentSubmissions = await env.DB.prepare("SELECT COUNT(*) AS count FROM match_request WHERE email=? AND created_at>=datetime('now','-1 day')").bind(email).first<{count:number}>();
    if ((recentSubmissions?.count || 0) >= 5) return json({error:"今日提交次数已达上限，请稍后再试"},{status:429});
    let riskSnapshot:string|null = null;
    if (stockCode) {
      const conditions = shareholder ? "stock_code=? AND shareholder=?" : "stock_code=?";
      const bindings = shareholder ? [stockCode,shareholder] : [stockCode];
      const snapshot = await env.DB.prepare(`SELECT COUNT(*) AS events,SUM(CASE WHEN type LIKE '%补充%' THEN 1 ELSE 0 END) AS supplemental,SUM(CASE WHEN type LIKE '%解除%' THEN 1 ELSE 0 END) AS releases,COUNT(DISTINCT pledgee) AS pledgees,MIN(announce_date) AS firstDate,MAX(announce_date) AS latestDate FROM pledge WHERE ${conditions}`).bind(...bindings).first();
      riskSnapshot = JSON.stringify({ stockCode,shareholder:shareholder || null,officialEventSummary:snapshot || null,generatedAt:new Date().toISOString(),limitation:"仅基于当前已解析官方公告，不代表当前存量质押或授信结论" });
    }
    const now = new Date().toISOString();
    const fingerprintSource = [role,email,organization,stockCode,shareholder,amountMin,amountMax,shanghaiDate()].join("|").toLowerCase();
    const requestFingerprint = hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(fingerprintSource)));
    await env.DB.prepare("INSERT OR IGNORE INTO match_request (role,organization,contact_name,email,stock_code,shareholder,amount_min,amount_max,term_months,preference,purpose,notes,risk_snapshot,status,viewer_id,request_fingerprint,consent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?,?)").bind(role,organization,contactName,email,stockCode||null,shareholder||null,amountMin,amountMax,termMonths,preference||null,purpose||null,notes||null,riskSnapshot,viewer,requestFingerprint,now,now).run();
    const saved = await env.DB.prepare("SELECT id,status,created_at AS createdAt FROM match_request WHERE request_fingerprint=?").bind(requestFingerprint).first<{id:number;status:string;createdAt:string}>();
    if (saved) await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("match_request",String(saved.id),"submitted",JSON.stringify({role,stockCode:stockCode||null,shareholder:shareholder||null,amountMin,amountMax,status:saved.status}),viewer,now).run();
    const candidatesCreated = saved ? await refreshMatchCandidates(env.DB,saved.id) : 0;
    return json({ok:true,requestId:saved?.id,status:saved?.status||"new",message:"需求已进入人工核验队列；联系方式不会公开，双方确认后再安排对接",riskContextAttached:Boolean(riskSnapshot),candidatesCreated});
  }
  if (url.pathname === "/api/events" && request.method === "GET") {
    const conditions: string[] = []; const values: string[] = [];
    const add = (sql: string, value: string | null) => { if (value) { conditions.push(sql); values.push(value); } };
    add("CAST(p.id AS TEXT) = ?", url.searchParams.get("id"));
    add("p.announcement_id = ?", url.searchParams.get("announcement_id"));
    add("p.announce_date = ?", url.searchParams.get("date"));
    add("p.type = ?", url.searchParams.get("event_type"));
    add("p.stock_code = ?", url.searchParams.get("stock"));
    const shareholder = url.searchParams.get("shareholder"); if (shareholder) { conditions.push("p.shareholder LIKE ?"); values.push(`%${shareholder}%`); }
    const pledgee = url.searchParams.get("pledgee"); if (pledgee) { conditions.push("p.pledgee LIKE ?"); values.push(`%${pledgee}%`); }
    const q = url.searchParams.get("q"); if (q) { conditions.push("(p.stock_code LIKE ? OR p.stock_name LIKE ? OR p.shareholder LIKE ? OR p.pledgee LIKE ?)"); values.push(...Array(4).fill(`%${q}%`)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500); const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const sql = `SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,p.confidence,p.parser_version AS parserVersion,p.verification_status AS verificationStatus,p.verified_at AS verifiedAt,p.verified_by AS verifiedBy,p.evidence_json AS evidenceJson,a.source,a.pdf_url AS pdfUrl,a.md5,a.sha256 FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id ${where} ORDER BY p.announce_date DESC,p.id DESC LIMIT ? OFFSET ?`;
    const [result,count] = await Promise.all([env.DB.prepare(sql).bind(...values,limit,offset).all(),env.DB.prepare(`SELECT COUNT(*) AS total FROM pledge p ${where}`).bind(...values).first<{total:number}>()]);
    return json({ data: result.results, total: count?.total || 0, limit, offset, traceable: true });
  }
  if (url.pathname === "/api/announcements" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT announcement_id AS announcementId,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,source,crawl_time AS crawlTime,md5,sha256,parse_status AS parseStatus,parse_attempts AS parseAttempts,last_error AS lastError FROM announcement ORDER BY announce_date DESC LIMIT 500").all();
    return json({ data: result.results, total: result.results.length });
  }
  if (url.pathname === "/api/sync-runs" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT id,source,started_at AS startedAt,finished_at AS finishedAt,status,announcements_found AS announcementsFound,events_created AS eventsCreated,failures,message FROM sync_run ORDER BY id DESC LIMIT 100").all();
    return json({ data: result.results });
  }
  if (url.pathname === "/api/process" && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const input = await request.json<{limit?:number;date?:string}>().catch(() => ({}));
    const priorityDate=/^\d{4}-\d{2}-\d{2}$/.test(input.date||"")?input.date:undefined;
    return json({ ok:true,...await processPendingQueue(env.DB,env.DOCUMENTS,Number(input.limit) || 3,env,priorityDate) });
  }
  if (url.pathname === "/api/reprocess-reviews" && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const input = await request.json<{limit?:number;force?:boolean;date?:string}>().catch(() => ({}));
    const limit = Math.min(Math.max(Number(input.limit) || 3,1),10);
    const date=/^\d{4}-\d{2}-\d{2}$/.test(input.date||"")?input.date:undefined;
    const pending = date
      ? await env.DB.prepare("SELECT r.announcement_id AS id FROM review_queue r JOIN announcement a ON a.announcement_id=r.announcement_id WHERE r.status='pending' AND a.announce_date=? ORDER BY CASE WHEN r.reviewed_at IS NULL THEN 0 ELSE 1 END,COALESCE(r.reviewed_at,r.created_at) ASC LIMIT ?").bind(date,limit).all<{id:string}>()
      : await env.DB.prepare("SELECT announcement_id AS id FROM review_queue WHERE status='pending' ORDER BY CASE WHEN reviewed_at IS NULL THEN 0 ELSE 1 END,COALESCE(reviewed_at,created_at) ASC LIMIT ?").bind(limit).all<{id:string}>();
    const results: unknown[] = [];
    for (const row of pending.results) {
      try { results.push(await processAnnouncement(env.DB,env.DOCUMENTS,row.id,env,{forceOpenAI:input.force === true})); }
      catch (error) { results.push({id:row.id,status:"failed",error:error instanceof Error ? error.message : "reprocess failed"}); }
    }
    return json({ok:true,requested:limit,processed:results.length,results});
  }
  if (url.pathname.startsWith("/api/review-corrections/") && request.method === "POST") {
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const date=decodeURIComponent(url.pathname.split("/").pop()||"");
    const corrections=OFFICIAL_DATE_CORRECTIONS[date];
    if(!corrections)return json({error:"该日期没有已签署的逐页复核校正集"},{status:404});
    const now=new Date().toISOString();let announcements=0;let events=0;const failures:Array<{stockCode:string;error:string}>=[];
    for(const correction of corrections){
      try{
        const announcement=await env.DB.prepare("SELECT announcement_id AS id,title FROM announcement WHERE stock_code=? AND announce_date=? ORDER BY CASE WHEN source='巨潮资讯' THEN 0 ELSE 1 END LIMIT 1").bind(correction.stockCode,date).first<{id:string;title:string}>();
        if(!announcement)throw new Error("主库未找到对应公告");
        const rows=correction.events.map((event)=>validateAndNormalizePledgeRow({...event,missing:[]} as ParsedPledge));
        const invalid=rows.find((row)=>row.missing.length);if(invalid)throw new Error(`校正数据未通过严格校验：${invalid.missing.join("、")}`);
        const statements:D1PreparedStatement[]=[env.DB.prepare("DELETE FROM pledge WHERE announcement_id=?").bind(announcement.id)];
        for(let index=0;index<rows.length;index++){
          const row=rows[index];const eventFingerprint=await fingerprint(announcement.id,row,index);
          const evidence=JSON.stringify({announcementId:announcement.id,method:"human",pageNumber:1,fields:["shareholder","pledgee","pledgeAmount","pledgeRatio","totalRatio"],reviewSet:`official-${date}-v1`});
          statements.push(env.DB.prepare("INSERT INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at,event_fingerprint,verification_status,verified_at,verified_by,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(announcement.id,correction.stockCode,correction.stockName,row.shareholder,row.pledgee,row.amount,row.amountText,row.pledgeRatio||null,row.totalRatio||null,row.startDate||null,row.endDate||null,row.purpose||null,row.type,date,1,"human-pdf-review-v1",now,eventFingerprint,"human_verified",now,viewer,evidence));
        }
        statements.push(
          env.DB.prepare("UPDATE announcement SET parse_status='parsed',last_error=NULL WHERE announcement_id=?").bind(announcement.id),
          env.DB.prepare("UPDATE review_queue SET status='approved',reason='逐页对照官方PDF人工复核通过',reviewed_at=?,reviewer=?,resolution=? WHERE announcement_id=? AND status='pending'").bind(now,viewer,JSON.stringify({reviewSet:`official-${date}-v1`,events:rows.length,title:announcement.title}),announcement.id),
          env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",announcement.id,"official_pdf_correction",JSON.stringify({date,stockCode:correction.stockCode,events:rows.length,reviewSet:`official-${date}-v1`}),viewer,now),
        );
        await env.DB.batch(statements);announcements++;events+=rows.length;
      }catch(error){failures.push({stockCode:correction.stockCode,error:error instanceof Error?error.message:"校正失败"});}
    }
    return json({ok:failures.length===0,date,announcements,events,failures,reviewSet:`official-${date}-v1`},{status:failures.length?207:200});
  }
  if (url.pathname.startsWith("/api/announcements/") && url.pathname.endsWith("/process") && request.method === "POST") {
    if(!adminViewer(request,env))return adminRequired();
    const id = url.pathname.split("/")[3];
    return json(await processAnnouncement(env.DB, env.DOCUMENTS, id, env));
  }
  if (url.pathname.startsWith("/api/announcements/") && url.pathname.endsWith("/archive") && request.method === "POST") {
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const id = url.pathname.split("/")[3]; const item = await env.DB.prepare("SELECT pdf_url AS pdfUrl FROM announcement WHERE announcement_id=?").bind(id).first<{pdfUrl:string}>();
    if (!item?.pdfUrl) return json({error:"announcement not found"},{status:404});
    const response = await fetch(item.pdfUrl,{headers:{referer:"https://www.cninfo.com.cn/","user-agent":"Mozilla/5.0 (compatible; StockEventDB/1.0)"}}); if (!response.ok) return json({error:`PDF download failed: ${response.status}`},{status:502});
    const bytes = await response.arrayBuffer(); const sha256 = hex(await crypto.subtle.digest("SHA-256",bytes)); const key = `announcements/${id}.pdf`;
    await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:"application/pdf"},customMetadata:{announcementId:id,sha256}});
    await env.DB.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status=? WHERE announcement_id=?").bind(key,sha256,"archived",id).run();
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",id,"archive",JSON.stringify({key,sha256,size:bytes.byteLength}),viewer,new Date().toISOString()).run();
    return json({ok:true,key,sha256,size:bytes.byteLength});
  }
  if (url.pathname === "/api/reviews" && request.method === "GET") {
    if(!adminViewer(request,env))return adminRequired();
    const result = await env.DB.prepare("SELECT r.id,r.announcement_id AS announcementId,r.event_type AS eventType,r.reason,r.payload,r.status,r.created_at AS createdAt,r.reviewed_at AS reviewedAt,r.resolution,a.stock_code AS stockCode,a.stock_name AS stockName,a.title,a.announce_date AS announceDate,a.pdf_url AS pdfUrl FROM review_queue r JOIN announcement a ON a.announcement_id=r.announcement_id ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 200").all();
    return json({ data: result.results });
  }
  if (url.pathname.startsWith("/api/reviews/") && request.method === "PATCH") {
    const viewer=adminViewer(request,env);if(!viewer)return adminRequired();
    const id = Number(url.pathname.split("/").pop());
    const body = await request.json<{status?:string;resolution?:string;shareholder?:string;pledgee?:string;amount?:number;amountText?:string;pledgeRatio?:string;totalRatio?:string;type?:string}>();
    if (!id || !["approved","rejected"].includes(body.status || "")) return json({ error: "invalid review update" }, { status: 400 });
    const before = await env.DB.prepare("SELECT * FROM review_queue WHERE id=?").bind(id).first<{announcement_id:string;status:string;payload:string}>();
    if (!before) return json({ error: "review not found" }, { status: 404 });
    if (before.status !== "pending") return json({ error: "review already completed" }, { status: 409 });
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE review_queue SET status=?,resolution=?,reviewed_at=?,reviewer=? WHERE id=?").bind(body.status,body.resolution || "",now,viewer,id),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,before_json,after_json,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind("review_queue",String(id),"review",JSON.stringify(before),JSON.stringify(body),viewer,now),
    ];
    if (body.status === "approved") {
      const announcement = await env.DB.prepare("SELECT stock_code AS stockCode,stock_name AS stockName,announce_date AS announceDate FROM announcement WHERE announcement_id=?").bind(before.announcement_id).first<{stockCode:string;stockName:string;announceDate:string}>();
      if (!announcement || !body.shareholder?.trim() || !body.pledgee?.trim() || !Number(body.amount)) return json({ error: "股东、质权人和质押数量为必填项" }, { status: 400 });
      const manualRow=validateAndNormalizePledgeRow({shareholder:body.shareholder.trim(),pledgee:body.pledgee.trim(),amount:Number(body.amount),amountText:body.amountText||String(body.amount),pledgeRatio:body.pledgeRatio||"",totalRatio:body.totalRatio||"",startDate:"",endDate:"",purpose:"",type:body.type||"新增质押",missing:[]}) as ParsedPledge;
      if(manualRow.missing.length)return json({error:`人工审核数据未通过严格校验：${manualRow.missing.join("、")}`},{status:400});
      const eventFingerprint=await fingerprint(before.announcement_id,manualRow,0);
      statements.push(
        env.DB.prepare("DELETE FROM pledge WHERE announcement_id=?").bind(before.announcement_id),
        env.DB.prepare("INSERT INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,type,announce_date,confidence,parser_version,parsed_at,event_fingerprint,verification_status,verified_at,verified_by,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(before.announcement_id,announcement.stockCode,announcement.stockName,manualRow.shareholder,manualRow.pledgee,manualRow.amount,manualRow.amountText,manualRow.pledgeRatio||null,manualRow.totalRatio||null,manualRow.type,announcement.announceDate,1,"manual-review-v2",now,eventFingerprint,"human_verified",now,viewer,eventEvidence(before.announcement_id,[],manualRow,"human")),
        env.DB.prepare("UPDATE announcement SET parse_status='parsed' WHERE announcement_id=?").bind(before.announcement_id),
      );
    } else {
      statements.push(env.DB.prepare("UPDATE announcement SET parse_status='rejected' WHERE announcement_id=?").bind(before.announcement_id));
    }
    await env.DB.batch(statements);
    return json({ ok: true, status: body.status });
  }
  if (url.pathname === "/api/export" && request.method === "GET") {
    const format = url.searchParams.get("format") || "csv";
    if(format!=="csv"){
      const viewer=viewerId(request);if(!viewer)return json({error:"请先登录后使用高级导出",upgrade:"/pricing"},{status:401});
      const account=await env.DB.prepare("SELECT plan,status FROM billing_account WHERE user_id=?").bind(viewer).first<{plan:string;status:string}>();
      if(!account||!entitlementsFor(account.plan,account.status).advancedExport)return json({error:"Excel 与 JSON 导出属于专业版权益",upgrade:"/pricing",requiredEntitlement:"advancedExport"},{status:402});
    }
    const result = await env.DB.prepare("SELECT announce_date,stock_code,stock_name,shareholder,pledgee,pledge_amount_text,pledge_ratio,total_ratio,type,verification_status FROM pledge ORDER BY announce_date DESC").all<Record<string, unknown>>();
    if (format === "json") return json(result.results, { headers: { "content-disposition": "attachment; filename=pledge-events.json" } });
    const cols = ["announce_date","stock_code","stock_name","shareholder","pledgee","pledge_amount_text","pledge_ratio","total_ratio","type","verification_status"];
    if (format === "xls") {
      const escapeXml = (value: unknown) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
      const labels = ["公告日期","股票代码","股票名称","股东名称","质权人","质押数量","占其持股","占总股本","事件类型","核验层级"];
      const rowXml = (cells: unknown[]) => `<Row>${cells.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>`).join("")}</Row>`;
      const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="股权质押"><Table>${rowXml(labels)}${result.results.map((row) => rowXml(cols.map((col) => row[col]))).join("")}</Table></Worksheet></Workbook>`;
      return new Response(xml,{headers:{"content-type":"application/vnd.ms-excel; charset=utf-8","content-disposition":"attachment; filename=pledge-events.xls"}});
    }
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
    if (url.pathname.startsWith("/api/")) { try { return await api(request, env, ctx); } catch (error) { return json({ error: error instanceof Error ? error.message : "internal error" }, { status: 500 }); } }
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, { fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))), transformImage: async (body, { width, format, quality }) => { const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality }); return result.response(); } }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};
export default worker;
