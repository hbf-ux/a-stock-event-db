import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { extractText, getDocumentProxy } from "unpdf";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
  /** Legacy fields retained for schema compatibility; V1-Lite never reads them. */
  OPENAI_API_KEY?: string;
  OPENAI_OCR_MODEL?: string;
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers || {}) } });
const viewerId = (request: Request) => request.headers.get("oai-authenticated-user-id")?.trim() || null;

async function ensureSchema(db: D1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS stock_info (code TEXT PRIMARY KEY, name TEXT NOT NULL, exchange TEXT NOT NULL, industry TEXT, list_date TEXT, status TEXT NOT NULL DEFAULT '上市')`,
    `CREATE TABLE IF NOT EXISTS announcement (announcement_id TEXT PRIMARY KEY, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, title TEXT NOT NULL, announce_date TEXT NOT NULL, pdf_url TEXT, r2_key TEXT, source TEXT NOT NULL, crawl_time TEXT NOT NULL, md5 TEXT NOT NULL UNIQUE, sha256 TEXT, parse_status TEXT NOT NULL DEFAULT 'pending', parse_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
    `CREATE TABLE IF NOT EXISTS pledge (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, shareholder TEXT NOT NULL, pledgee TEXT NOT NULL, pledge_amount REAL NOT NULL, pledge_amount_text TEXT NOT NULL, pledge_ratio TEXT, total_ratio TEXT, start_date TEXT, end_date TEXT, purpose TEXT, type TEXT NOT NULL, announce_date TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, parser_version TEXT NOT NULL, parsed_at TEXT NOT NULL, UNIQUE(announcement_id, shareholder, type))`,
    `CREATE TABLE IF NOT EXISTS review_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, event_type TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT, reviewer TEXT, resolution TEXT)`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sync_run (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, announcements_found INTEGER NOT NULL DEFAULT 0, events_created INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, message TEXT)`,
    `CREATE TABLE IF NOT EXISTS subscription_interest (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, plan TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'pricing-modal', created_at TEXT NOT NULL, UNIQUE(email, plan))`,
    `CREATE TABLE IF NOT EXISTS user_watchlist (user_id TEXT NOT NULL, stock_code TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, stock_code))`,
    `CREATE INDEX IF NOT EXISTS user_watchlist_user_idx ON user_watchlist (user_id)`,
    `CREATE TABLE IF NOT EXISTS shareholder_profile (stock_code TEXT NOT NULL, shareholder TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT '股东', is_controller INTEGER NOT NULL DEFAULT 0, is_controlling_shareholder INTEGER NOT NULL DEFAULT 0, holding_shares REAL, holding_ratio TEXT, source_title TEXT, source_url TEXT, source_date TEXT, confidence REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (stock_code, shareholder))`,
    `CREATE INDEX IF NOT EXISTS shareholder_profile_stock_idx ON shareholder_profile (stock_code)`,
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
  const invalidEvents = await db.prepare("SELECT DISTINCT announcement_id FROM pledge WHERE pledgee LIKE '占其%' OR pledgee LIKE '占公司%' OR pledgee LIKE '质押数量%' OR pledgee LIKE '%有限公司补充%' OR shareholder IN ('借款','质押','补充质押','偿还借款') OR (parser_version LIKE 'unpdf-table-rules%' AND (shareholder LIKE '%质押%' OR shareholder LIKE '%融资%'))").all<{announcement_id:string}>();
  if (invalidEvents.results.length) {
    const ids = invalidEvents.results.map((row) => row.announcement_id);
    for (const id of ids) await db.batch([
      db.prepare("DELETE FROM pledge WHERE announcement_id=?").bind(id),
      db.prepare("UPDATE announcement SET parse_status='review',last_error='entity validation rejected parser output' WHERE announcement_id=?").bind(id),
      db.prepare("UPDATE review_queue SET status='pending',reviewed_at=NULL,reviewer=NULL,reason='实体校验未通过：质权人疑似表头文本' WHERE announcement_id=?").bind(id),
    ]);
  }
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
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve,milliseconds));
async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(input,init);
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      if (attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
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

const validateParsedRows = (rows: ParsedPledge[]) => rows.map((row) => {
  const invalidPledgee = row.pledgee.length < 3 || /^(占其|占公司|质押数量|比例|本次|股东)/.test(row.pledgee);
  const missing = [!row.shareholder && "股东", (!row.pledgee || invalidPledgee) && "质权人", !row.amount && "质押数量"].filter(Boolean);
  return {...row,missing} as ParsedPledge;
});

async function parseWithOpenAI(pdfBase64: string, title: string, env: Env) {
  if (!env.OPENAI_API_KEY) return [];
  const response = await fetchWithRetry("https://api.openai.com/v1/responses", { method:"POST", headers:{ authorization:`Bearer ${env.OPENAI_API_KEY}`, "content-type":"application/json" }, body:JSON.stringify({ model:env.OPENAI_OCR_MODEL || "gpt-5.6-luna", input:[{ role:"user", content:[{ type:"input_file", filename:"announcement.pdf", file_data:`data:application/pdf;base64,${pdfBase64}` },{ type:"input_text", text:`Extract every share pledge or release row from this A-share announcement titled ${title}. Return JSON only as {\"events\":[{\"shareholder\":\"\",\"pledgee\":\"\",\"pledge_amount\":\"\",\"pledge_ratio\":\"\",\"total_ratio\":\"\",\"start_date\":\"\",\"end_date\":\"\",\"purpose\":\"\",\"type\":\"新增质押|补充质押|解除质押|解除后再质押\"}]}. Never invent missing values.` }] }] }) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0,500);
    throw new Error(`OpenAI OCR failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const payload = await response.json<Record<string, unknown>>();
  const outputText = String(payload.output_text || ((payload.output as Array<{content?:Array<{text?:string}>}> | undefined)?.flatMap((item) => item.content || []).map((item) => item.text || "").join("") || ""));
  const jsonText = outputText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return normalizeVisionRows(JSON.parse(jsonText), title);
}

async function fingerprint(id: string, row: ParsedPledge, index: number) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([id,row.shareholder,row.pledgee,row.amountText,row.startDate,row.type,index].join("|"))));
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

async function processAnnouncement(db: D1Database, documents: R2Bucket, id: string, env?: Env) {
  const item = await db.prepare("SELECT announcement_id AS id,stock_code AS stockCode,stock_name AS stockName,title,announce_date AS announceDate,pdf_url AS pdfUrl,r2_key AS r2Key,sha256 FROM announcement WHERE announcement_id=?").bind(id).first<{id:string;stockCode:string;stockName:string;title:string;announceDate:string;pdfUrl:string;r2Key?:string;sha256?:string}>();
  if (!item) throw new Error("announcement not found");
  let bytes: ArrayBuffer; let r2Key = item.r2Key; let sha256 = item.sha256;
  if (r2Key) { const object = await documents.get(r2Key); if (!object) throw new Error("archived PDF not found"); bytes = await object.arrayBuffer(); }
  else {
    const response = await fetchWithRetry(item.pdfUrl,{headers:{referer:"https://www.cninfo.com.cn/","user-agent":"Mozilla/5.0 (compatible; StockEventDB/1.0)"}});
    if (!response.ok) throw new Error(`PDF download failed: ${response.status}`);
    bytes = await response.arrayBuffer(); sha256 = hex(await crypto.subtle.digest("SHA-256",bytes)); r2Key = `announcements/${id}.pdf`;
    await documents.put(r2Key,bytes,{httpMetadata:{contentType:"application/pdf"},customMetadata:{announcementId:id,sha256}});
  }
  const pdf = await getDocumentProxy(new Uint8Array(bytes)); const extracted = await extractText(pdf,{mergePages:true});
  const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  await documents.put(`announcements/${id}.txt`,text,{httpMetadata:{contentType:"text/plain; charset=utf-8"}});
  let rows = validateParsedRows(parsePledgeRows(text,item.title)); let parserVersion = "unpdf-table-rules-v2.1-lite"; let confidence = rows.length > 1 ? 0.88 : 0.82;
  // V1-Lite is local-only: PDFs that do not yield complete deterministic rows
  // stay in the manual review queue; no OCR/LLM request is ever made.
  const completeRows = rows.filter((row) => !row.missing.length); const parsed = rows[0]; const now = new Date().toISOString();
  if (!completeRows.length) {
    const missing = parsed?.missing || ["股东","质权人","质押数量"];
    await db.batch([
      db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='review',last_error=NULL WHERE announcement_id=?").bind(r2Key,sha256,id),
      db.prepare("UPDATE review_queue SET reason=?,payload=? WHERE announcement_id=? AND status='pending'").bind(`本地规则解析缺少字段：${missing.join("、")}；V1-Lite 未启用 OCR，请人工审核`,JSON.stringify({...parsed,candidates:rows,textKey:`announcements/${id}.txt`,ocrConfigured:false}),id),
      db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("announcement",id,"parse_review",JSON.stringify({missing,parserVersion,ocrConfigured:false}),"worker",now),
    ]);
    return {id,status:"review",missing,ocr_attempted:false};
  }
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < completeRows.length; index++) {
    const row = completeRows[index]; const eventFingerprint = await fingerprint(id,row,index);
    statements.push(db.prepare("INSERT OR IGNORE INTO pledge (announcement_id,stock_code,stock_name,shareholder,pledgee,pledge_amount,pledge_amount_text,pledge_ratio,total_ratio,start_date,end_date,purpose,type,announce_date,confidence,parser_version,parsed_at,event_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.stockCode,item.stockName,row.shareholder,row.pledgee,row.amount,row.amountText,row.pledgeRatio||null,row.totalRatio||null,row.startDate||null,row.endDate||null,row.purpose||null,row.type,item.announceDate,confidence,parserVersion,now,eventFingerprint));
  }
  statements.push(
    db.prepare("UPDATE announcement SET r2_key=?,sha256=?,parse_status='parsed',last_error=NULL WHERE announcement_id=?").bind(r2Key,sha256,id),
    db.prepare("UPDATE review_queue SET status='approved',reason='自动解析字段完整',reviewed_at=?,reviewer='worker',resolution=? WHERE announcement_id=? AND status='pending'").bind(now,JSON.stringify(completeRows),id),
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,action,after_json,actor,created_at) VALUES (?,?,?,?,?,?)").bind("pledge",id,"auto_parse",JSON.stringify({events:completeRows,eventCount:completeRows.length,parserVersion}),"worker",now),
  );
  await db.batch(statements);
  return {id,status:"parsed",events:completeRows,event_count:completeRows.length,parser_version:parserVersion};
}

async function processPendingQueue(db: D1Database, documents: R2Bucket, requestedLimit = 3, env?: Env) {
  const limit = Math.min(Math.max(requestedLimit, 1), 10);
  const startedAt = new Date().toISOString();
  const run = await db.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("pdf-parser",startedAt,"running",`开始处理最多 ${limit} 条公告`).first<{id:number}>();
  const pending = await db.prepare("SELECT announcement_id AS id FROM announcement WHERE parse_status IN ('queued','archived') ORDER BY announce_date DESC LIMIT ?").bind(limit).all<{id:string}>();
  const results: unknown[] = []; let parsed = 0; let failures = 0;
  for (const row of pending.results) {
    try { const result = await processAnnouncement(db,documents,row.id,env); results.push(result); if (result.status === "parsed") parsed += result.event_count || 1; }
    catch (error) {
      failures++; const message = error instanceof Error ? error.message : "parse failed";
      await db.prepare("UPDATE announcement SET parse_attempts=parse_attempts+1,last_error=? WHERE announcement_id=?").bind(message,row.id).run();
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

async function fetchCninfo(date: string) {
  const all: CninfoAnnouncement[] = [];
  for (const column of ["szse", "sse"]) {
    const body = new URLSearchParams({ pageNum: "1", pageSize: "100", column, tabName: "fulltext", plate: "", stock: "", searchkey: "质押", secid: "", category: "", trade: "", seDate: `${date}~${date}`, sortName: "", sortType: "", isHLtitle: "true" });
    const response = await fetchWithRetry("https://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json, text/plain, */*", referer: "https://www.cninfo.com.cn/new/disclosure", "user-agent": "Mozilla/5.0 (compatible; StockEventDB/1.0; public-disclosure-research)" }, body });
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

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    const stats = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM announcement) announcements, (SELECT COUNT(*) FROM pledge) events, (SELECT COUNT(*) FROM review_queue WHERE status='pending') pending_reviews").first();
    return json({ status: "ok", storage: { d1: true, r2: true }, ocr: { configured: false, mode: "disabled-v1-lite" }, stats, timestamp: new Date().toISOString() });
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
    const input = await request.json<{date?:string}>().catch(() => ({})); const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date(Date.now() - 86400000).toISOString().slice(0,10);
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
  if (url.pathname === "/api/backfill" && request.method === "POST") {
    const input = await request.json<{days?:number;endDate?:string}>().catch(() => ({}));
    const days = Math.min(Math.max(Number(input.days) || 7,1),7);
    const endDate = input.endDate && /^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? input.endDate : new Date().toISOString().slice(0,10);
    const end = new Date(`${endDate}T00:00:00Z`); const startedAt = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO sync_run (source,started_at,status,message) VALUES (?,?,?,?) RETURNING id").bind("historical-backfill",startedAt,"running",`回补 ${days} 日公告`).first<{id:number}>();
    let found = 0; let inserted = 0; let failures = 0; const dates: {date:string;found:number;inserted:number;error?:string}[] = [];
    for (let index = days - 1; index >= 0; index--) {
      const current = new Date(end); current.setUTCDate(end.getUTCDate() - index); const date = current.toISOString().slice(0,10);
      try { const result = await ingestCninfo(env.DB,date); found += result.found; inserted += result.inserted; dates.push({date,...result}); }
      catch (error) { failures++; dates.push({date,found:0,inserted:0,error:error instanceof Error ? error.message : "sync failed"}); }
    }
    await env.DB.prepare("UPDATE sync_run SET finished_at=?,status=?,announcements_found=?,failures=?,message=? WHERE id=?").bind(new Date().toISOString(),failures ? "completed_with_errors" : "completed",found,failures,`回补 ${days} 日：发现 ${found} 条，新增 ${inserted} 条，失败日期 ${failures} 个`,run?.id).run();
    ctx.waitUntil(processPendingQueue(env.DB,env.DOCUMENTS,10,env));
    return json({ok:true,run_id:run?.id,days,end_date:endDate,announcements_found:found,announcements_inserted:inserted,failures,dates,auto_processing:true});
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
  if (url.pathname === "/api/feed" && request.method === "GET") {
    const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 24, 1), 168);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const result = await env.DB.prepare("SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,a.crawl_time AS crawledAt,a.title,a.source,a.pdf_url AS pdfUrl,p.confidence,p.parser_version AS parserVersion FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id WHERE a.crawl_time >= ? ORDER BY a.crawl_time DESC,p.id DESC LIMIT ?").bind(since, limit).all();
    return json({ data: result.results, hours, limit, since, generatedAt: new Date().toISOString(), freshness: "official-announcement-crawl" });
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
    const userId = viewerId(request);
    if (!userId) return json({ error: "sign-in-required" }, { status: 401 });
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
  if (url.pathname === "/api/events" && request.method === "GET") {
    const conditions: string[] = []; const values: string[] = [];
    const add = (sql: string, value: string | null) => { if (value) { conditions.push(sql); values.push(value); } };
    add("p.announce_date = ?", url.searchParams.get("date"));
    add("p.type = ?", url.searchParams.get("event_type"));
    add("p.stock_code = ?", url.searchParams.get("stock"));
    const shareholder = url.searchParams.get("shareholder"); if (shareholder) { conditions.push("p.shareholder LIKE ?"); values.push(`%${shareholder}%`); }
    const pledgee = url.searchParams.get("pledgee"); if (pledgee) { conditions.push("p.pledgee LIKE ?"); values.push(`%${pledgee}%`); }
    const q = url.searchParams.get("q"); if (q) { conditions.push("(p.stock_code LIKE ? OR p.stock_name LIKE ? OR p.shareholder LIKE ? OR p.pledgee LIKE ?)"); values.push(...Array(4).fill(`%${q}%`)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500); const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const sql = `SELECT p.id,p.announcement_id AS announcementId,p.stock_code AS code,p.stock_name AS name,p.shareholder,p.pledgee,p.pledge_amount_text AS amount,p.pledge_ratio AS ratio,p.total_ratio AS total,p.type,p.announce_date AS date,p.confidence,p.parser_version AS parserVersion,a.source,a.pdf_url AS pdfUrl,a.md5,a.sha256 FROM pledge p JOIN announcement a ON a.announcement_id=p.announcement_id ${where} ORDER BY p.announce_date DESC,p.id DESC LIMIT ? OFFSET ?`;
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
    const input = await request.json<{limit?:number}>().catch(() => ({}));
    return json({ ok:true,...await processPendingQueue(env.DB,env.DOCUMENTS,Number(input.limit) || 3,env) });
  }
  if (url.pathname === "/api/reprocess-reviews" && request.method === "POST") {
    const input = await request.json<{limit?:number}>().catch(() => ({}));
    const limit = Math.min(Math.max(Number(input.limit) || 3,1),5);
    const pending = await env.DB.prepare("SELECT DISTINCT announcement_id AS id FROM review_queue WHERE status='pending' ORDER BY created_at ASC LIMIT ?").bind(limit).all<{id:string}>();
    const results: unknown[] = [];
    for (const row of pending.results) {
      try { results.push(await processAnnouncement(env.DB,env.DOCUMENTS,row.id,env)); }
      catch (error) { results.push({id:row.id,status:"failed",error:error instanceof Error ? error.message : "reprocess failed"}); }
    }
    return json({ok:true,requested:limit,processed:results.length,results});
  }
  if (url.pathname.startsWith("/api/announcements/") && url.pathname.endsWith("/process") && request.method === "POST") {
    const id = url.pathname.split("/")[3];
    return json(await processAnnouncement(env.DB, env.DOCUMENTS, id, env));
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
    if (format === "xls") {
      const escapeXml = (value: unknown) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
      const labels = ["公告日期","股票代码","股票名称","股东名称","质权人","质押数量","占其持股","占总股本","事件类型"];
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
