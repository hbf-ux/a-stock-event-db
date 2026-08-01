import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("production site contains the real announcement workflow", async () => {
  const [page, worker, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  assert.match(page, /真实数据不为空/);
  assert.match(page, /处理待解析/);
  assert.match(page, /人工审核工作台/);
  assert.match(page, /审核通过并入库/);
  assert.match(page, /系统运行日志/);
  assert.match(page, /导出格式/);
  assert.match(page, /后台解析已启动/);
  assert.match(page, /近 14 日公告趋势/);
  assert.match(page, /主要质权人/);
  assert.match(page, /回补 7 日/);
  assert.match(page, /\/api\/announcements\/\$\{row\.announcementId\}\/process/);
  assert.match(worker, /from "unpdf"/);
  assert.match(worker, /async function processAnnouncement/);
  assert.match(worker, /parse_status='parsed'/);
  assert.match(worker, /manual-review-v2/);
  assert.match(worker, /review already completed/);
  assert.match(worker, /completed_with_errors/);
  assert.match(worker, /application\/vnd\.ms-excel/);
  assert.match(worker, /p\.shareholder LIKE/);
  assert.match(worker, /CAST\(p\.id AS TEXT\) = \?/);
  assert.match(worker, /ctx\.waitUntil\(processPendingQueue/);
  assert.match(worker, /parse_status IN \('queued','archived'\)/);
  assert.match(worker, /fetchWithRetry/);
  assert.match(worker, /parse_attempts=parse_attempts\+1/);
  assert.match(worker, /ALTER TABLE announcement ADD COLUMN parse_attempts/);
  assert.match(worker, /\/api\/stats/);
  assert.match(worker, /\/api\/backfill/);
  assert.match(worker, /\/api\/capital-signals/);
  assert.match(worker, /eventGap:"质押类事件数量减解除类事件数量/);
  assert.match(worker, /\/api\/match-requests/);
  assert.match(worker, /双方确认后再安排对接/);
  assert.match(worker, /requestFingerprint/);
  assert.match(worker, /refreshMatchCandidates/);
  assert.match(worker, /ready_to_connect/);
  assert.match(worker, /\/api\/match-funnel/);
  assert.match(worker, /\/api\/data-quality/);
  assert.match(worker, /requiredFieldRate/);
  assert.match(worker, /gapCandidates/);
  assert.match(worker, /交易所交叉补漏尚未形成完成性证明/);
  assert.match(worker, /fetchSseObservations/);
  assert.match(worker, /fetchSzseObservations/);
  assert.match(worker, /fetchBseObservations/);
  assert.match(worker, /\/api\/reconciliation\/run/);
  assert.match(worker, /missing_primary/);
  assert.match(worker, /对账结果不会自动进入正式事件库/);
  assert.match(worker, /promoteExchangeObservation/);
  assert.match(worker, /officialPdfHosts/);
  assert.match(worker, /manual-confirmed-official-pdf/);
  assert.match(worker, /promote\|reject/);
  assert.match(worker, /\/api\/reconciliation\/batch/);
  assert.match(worker, /\/api\/operations\/daily/);
  assert.match(worker, /runDailyProductionCycle/);
  assert.match(worker, /daily_production_last/);
  assert.match(worker, /请先登录后提交人工审核/);
  assert.match(worker, /\/api\/billing\/checkout/);
  assert.match(worker, /\/api\/billing\/webhook/);
  assert.match(worker, /verifyStripeSignature/);
  assert.match(worker, /checkout\.session\.completed/);
  assert.match(worker, /customer\.subscription\./);
  assert.match(worker, /requiredEntitlement:\"advancedExport\"/);
  assert.match(worker, /entitlementsFor/);
  assert.match(worker, /capital_stage='due_diligence'/);
  assert.match(worker, /stage_updated/);
  assert.match(worker, /需求已关闭，相关未完成候选不再推进/);
  assert.match(worker, /双方分别确认前不返回对方机构/);
  assert.match(worker, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(worker, /rules-then-openai/);
  assert.match(worker, /maxAutomaticAttempts: 2/);
  assert.match(worker, /parseSectionPledgeRows/);
  assert.match(worker, /unpdf-table-rules-v2\.4/);
  assert.match(worker, /const nextCursor=failures\?cursor:dates\[dates\.length-1\]/);
  assert.match(worker, /successfulQueries/);
  assert.match(worker, /sourceWarnings/);
  assert.match(worker, /openai_quota_blocked_until/);
  assert.match(worker, /verification_status/);
  assert.match(worker, /human_verified/);
  assert.match(worker, /ai_reviewed/);
  assert.match(worker, /eventEvidence/);
  assert.match(worker, /mergePages:false/);
  assert.match(worker, /backfillAnnouncementEvidence/);
  assert.match(worker, /evidence_backfill_attempt/);
  assert.match(worker, /runHistoricalBackfillBatch/);
  assert.match(worker, /runParserUpgradeRetry/);
  assert.match(worker, /parser_upgrade_v2_4_attempt/);
  assert.match(worker, /maybeStartAutomaticMaintenance/);
  assert.match(worker, /\/api\/maintenance/);
  assert.doesNotMatch(worker, /await seed\(env\.DB\)/);
  assert.match(layout, /A股股东融资风险即时情报与尽调报告/);
});

test("international intelligence and subscription surfaces use production data", async()=>{
  const [english,pricing,billingMigration]=await Promise.all([
    readFile(new URL("app/en/en-client.tsx",root),"utf8"),
    readFile(new URL("app/pricing/pricing-client.tsx",root),"utf8"),
    readFile(new URL("drizzle/0011_burly_shinko_yamashiro.sql",root),"utf8"),
  ]);
  assert.match(english,/\/api\/feed\?hours=168/);
  assert.match(english,/Shareholder financing risk/);
  assert.match(english,/OTC Filing Watch/);
  assert.match(pricing,/\/api\/billing\/checkout/);
  assert.match(pricing,/Global Filing Intelligence/);
  assert.match(pricing,/Payment details are collected by Stripe Checkout/);
  assert.match(billingMigration,/CREATE TABLE `billing_account`/);
  assert.match(billingMigration,/CREATE TABLE `billing_event`/);
});

test("deployment bundle exists", async () => {
  await access(new URL("dist/server/index.js", root));
  await access(new URL(".openai/hosting.json", root));
});

test("commercial intelligence pages are wired to verified event data", async () => {
  const [detail, company, shareholder, pledgee, event, capital, brief, match, matchDesk, quality, migration, matchMigration, funnelMigration, reconciliationMigration, reviewMigration] = await Promise.all([
    readFile(new URL("app/intelligence-detail.tsx", root), "utf8"),
    readFile(new URL("app/company/[code]/page.tsx", root), "utf8"),
    readFile(new URL("app/shareholder/[name]/page.tsx", root), "utf8"),
    readFile(new URL("app/pledgee/[name]/page.tsx", root), "utf8"),
    readFile(new URL("app/event/[id]/page.tsx", root), "utf8"),
    readFile(new URL("app/capital/page.tsx", root), "utf8"),
    readFile(new URL("app/brief/page.tsx", root), "utf8"),
    readFile(new URL("app/match/page.tsx", root), "utf8"),
    readFile(new URL("app/match/desk/page.tsx", root), "utf8"),
    readFile(new URL("app/quality/page.tsx", root), "utf8"),
    readFile(new URL("drizzle/0004_past_franklin_storm.sql", root), "utf8"),
    readFile(new URL("drizzle/0007_free_guardian.sql", root), "utf8"),
    readFile(new URL("drizzle/0008_wonderful_true_believers.sql", root), "utf8"),
    readFile(new URL("drizzle/0009_blue_mongoose.sql", root), "utf8"),
    readFile(new URL("drizzle/0010_lively_landau.sql", root), "utf8"),
  ]);
  assert.match(quality, /backfill-extend/);
  assert.match(detail, /质押事件时间线/);
  assert.match(detail, /完整股东融资风控报告/);
  assert.match(detail, /内测预约，不会产生扣费/);
  assert.match(detail, /官方原文/);
  assert.match(company, /kind="company"/);
  assert.match(shareholder, /kind="shareholder"/);
  assert.match(pledgee, /kind="pledgee"/);
  assert.match(event, /kind="event"/);
  assert.match(detail, /FIELD-LEVEL EVIDENCE/);
  assert.match(detail, /verificationStatus/);
  assert.match(quality, /VERIFICATION LADDER/);
  assert.match(quality, /AUTOMATIC DATA MAINTENANCE/);
  assert.match(quality, /新版解析候选/);
  assert.match(quality, /证据回填不会覆盖原有事件字段/);
  assert.match(await readFile(new URL("drizzle/0012_curvy_cardiac.sql",root),"utf8"),/verification_status/);
  assert.match(capital, /融资活跃度，不是信用评分/);
  assert.match(capital, /事件差，不是存量质押/);
  assert.match(brief, /A股质押情报简报/);
  assert.match(brief, /打印简报/);
  assert.match(match, /让真实融资需求与真实资金偏好相遇/);
  assert.match(match, /联系方式不会公开/);
  assert.match(match, /不承诺融资结果/);
  assert.match(matchDesk, /融资撮合工作台/);
  assert.match(matchDesk, /双方确认前/);
  assert.match(matchDesk, /尽调中/);
  assert.match(matchDesk, /关闭/);
  assert.match(quality, /数据可信度中心/);
  assert.match(quality, /不把“已抓取范围”包装成“全市场完整率”/);
  assert.match(quality, /缺口候选/);
  assert.match(quality, /解析器版本/);
  assert.match(quality, /交易所公告对账/);
  assert.match(quality, /运行官方对账/);
  assert.match(quality, /只有人工确认并校验官方 PDF 后才进入解析队列/);
  assert.match(quality, /确认补入/);
  assert.match(quality, /无需补入/);
  assert.match(quality, /每日数据生产闭环/);
  assert.match(quality, /批量确认补入/);
  assert.match(quality, /批量无需补入/);
  assert.match(migration, /CREATE TABLE `match_request`/);
  assert.match(matchMigration, /CREATE TABLE `match_candidate`/);
  assert.match(funnelMigration, /capital_stage/);
  assert.match(funnelMigration, /financing_stage/);
  assert.match(reconciliationMigration, /CREATE TABLE `exchange_observation`/);
  assert.match(reconciliationMigration, /exchange_observation_date_status_idx/);
  assert.match(reviewMigration, /review_status/);
  assert.match(reviewMigration, /review_note/);
});
