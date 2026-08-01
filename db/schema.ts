import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const stockInfo = sqliteTable("stock_info", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  exchange: text("exchange").notNull(),
  industry: text("industry"),
  listDate: text("list_date"),
  status: text("status").notNull().default("上市"),
});

export const announcements = sqliteTable("announcement", {
  announcementId: text("announcement_id").primaryKey(),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  title: text("title").notNull(),
  announceDate: text("announce_date").notNull(),
  pdfUrl: text("pdf_url"),
  r2Key: text("r2_key"),
  source: text("source").notNull(),
  crawlTime: text("crawl_time").notNull(),
  md5: text("md5").notNull(),
  sha256: text("sha256"),
  parseStatus: text("parse_status").notNull().default("pending"),
  parseAttempts: integer("parse_attempts").notNull().default(0),
  lastError: text("last_error"),
}, (table) => [uniqueIndex("announcement_md5_uq").on(table.md5)]);

export const pledges = sqliteTable("pledge", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  announcementId: text("announcement_id").notNull(),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  shareholder: text("shareholder").notNull(),
  pledgee: text("pledgee").notNull(),
  pledgeAmount: real("pledge_amount").notNull(),
  pledgeAmountText: text("pledge_amount_text").notNull(),
  pledgeRatio: text("pledge_ratio"),
  totalRatio: text("total_ratio"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  purpose: text("purpose"),
  type: text("type").notNull(),
  announceDate: text("announce_date").notNull(),
  confidence: real("confidence").notNull().default(0),
  parserVersion: text("parser_version").notNull(),
  parsedAt: text("parsed_at").notNull(),
  eventFingerprint: text("event_fingerprint").notNull(),
}, (table) => [uniqueIndex("pledge_event_fingerprint_uq").on(table.eventFingerprint)]);

export const reviewQueue = sqliteTable("review_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  announcementId: text("announcement_id").notNull(),
  eventType: text("event_type").notNull(),
  reason: text("reason").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  reviewedAt: text("reviewed_at"),
  reviewer: text("reviewer"),
  resolution: text("resolution"),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
});

export const syncRuns = sqliteTable("sync_run", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(),
  announcementsFound: integer("announcements_found").notNull().default(0),
  eventsCreated: integer("events_created").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  message: text("message"),
});

export const pipelineState = sqliteTable("pipeline_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const userWatchlist = sqliteTable("user_watchlist", {
  userId: text("user_id").notNull(),
  stockCode: text("stock_code").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.stockCode] })]);

export const shareholderProfiles = sqliteTable("shareholder_profile", {
  stockCode: text("stock_code").notNull(),
  shareholder: text("shareholder").notNull(),
  identityType: text("identity_type").notNull().default("股东"),
  isController: integer("is_controller", { mode: "boolean" }).notNull().default(false),
  isControllingShareholder: integer("is_controlling_shareholder", { mode: "boolean" }).notNull().default(false),
  holdingShares: real("holding_shares"),
  holdingRatio: text("holding_ratio"),
  sourceTitle: text("source_title"),
  sourceUrl: text("source_url"),
  sourceDate: text("source_date"),
  confidence: real("confidence").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
}, (table) => [primaryKey({ columns: [table.stockCode, table.shareholder] })]);

export const matchRequests = sqliteTable("match_request", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role: text("role").notNull(),
  organization: text("organization").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  stockCode: text("stock_code"),
  shareholder: text("shareholder"),
  amountMin: real("amount_min").notNull(),
  amountMax: real("amount_max").notNull(),
  termMonths: integer("term_months"),
  preference: text("preference"),
  purpose: text("purpose"),
  notes: text("notes"),
  riskSnapshot: text("risk_snapshot"),
  status: text("status").notNull().default("new"),
  viewerId: text("viewer_id"),
  requestFingerprint: text("request_fingerprint").notNull(),
  consentAt: text("consent_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("match_request_fingerprint_uq").on(table.requestFingerprint),
  index("match_request_role_status_idx").on(table.role, table.status),
  index("match_request_created_idx").on(table.createdAt),
  index("match_request_email_created_idx").on(table.email, table.createdAt),
]);

export const matchCandidates = sqliteTable("match_candidate", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capitalRequestId: integer("capital_request_id").notNull(),
  financingRequestId: integer("financing_request_id").notNull(),
  score: integer("score").notNull(),
  reasons: text("reasons").notNull(),
  status: text("status").notNull().default("candidate"),
  capitalConsented: integer("capital_consented", { mode: "boolean" }).notNull().default(false),
  financingConsented: integer("financing_consented", { mode: "boolean" }).notNull().default(false),
  capitalConsentedAt: text("capital_consented_at"),
  financingConsentedAt: text("financing_consented_at"),
  capitalStage: text("capital_stage").notNull().default("reviewing"),
  financingStage: text("financing_stage").notNull().default("reviewing"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("match_candidate_pair_uq").on(table.capitalRequestId, table.financingRequestId),
  index("match_candidate_capital_status_idx").on(table.capitalRequestId, table.status),
  index("match_candidate_financing_status_idx").on(table.financingRequestId, table.status),
]);
