import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("public product is a daily closing report backed by the production workflow", async () => {
  const [page, worker, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  assert.match(page, /DailyReportClient/);
  const daily=await readFile(new URL("app/daily-report-client.tsx",root),"utf8");
  assert.match(daily,/每日20:00关账/);
  assert.match(daily,/下载长图 PNG/);
  assert.match(daily,/打印 \/ 保存 PDF/);
  assert.match(daily,/下载归档 PNG/);
  assert.match(daily,/下载归档 PDF/);
  assert.match(daily,/AI 自动复核暂缓/);
  assert.match(daily,/当前北京时间/);
  assert.match(daily,/正在关账/);
  assert.match(daily,/日报将在20:00截止后进入关账/);
  assert.match(daily,/三所公告对账/);
  assert.match(daily,/未关账，不标注完整清单/);
  assert.match(daily,/提交撮合需求/);
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
  assert.match(worker, /支持指定日期全量分页/);
  assert.match(worker, /sourceRuns/);
  assert.match(worker, /三所均成功且未解决差异为零/);
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
  assert.match(worker, /ADMIN_USER_IDS/);
  assert.match(worker, /adminViewer/);
  assert.match(worker, /仅运营管理员可执行此操作/);
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
  assert.match(worker, /\/api\/internal\/production-tick/);
  assert.match(worker, /PRODUCTION_CRON_SECRET/);
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /cloudflare_cron_last/);
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
  assert.match(worker, /\/api\/daily-report/);
  assert.match(worker, /\/api\/daily-reports/);
  assert.match(worker, /dailyReportSnapshot/);
  assert.match(worker, /T20:00:00\+08:00/);
  assert.match(worker, /automaticProductionTargetDate/);
  assert.match(worker, /const \[stats,quotaState,automaticProduction,automaticMaintenance\]/);
  assert.match(worker, /automaticSync:automaticProduction/);
  assert.match(worker, /deterministic-reconciliation/);
  assert.match(worker, /await publishDailyReport/);
  assert.match(worker, /generateDailyReportArtifacts/);
  assert.match(worker, /locked-daily-report/);
  assert.match(worker, /pdfFromJpeg/);
  assert.match(worker, /三所对账、公告分类和全部事件核验完成后方可关账发布/);
  assert.doesNotMatch(worker, /await seed\(env\.DB\)/);
  assert.match(layout, /每日A股质押关账报告与融资撮合/);
});

test("international daily report and existing billing backend remain wired", async()=>{
  const [english,englishDetail,englishLanguage,englishCompany,pricing,billingMigration]=await Promise.all([
    readFile(new URL("app/en/en-client.tsx",root),"utf8"),
    readFile(new URL("app/en/intelligence-detail-en.tsx",root),"utf8"),
    readFile(new URL("app/en/en-language.tsx",root),"utf8"),
    readFile(new URL("app/en/company/[code]/page.tsx",root),"utf8"),
    readFile(new URL("app/pricing/pricing-client.tsx",root),"utf8"),
    readFile(new URL("drizzle/0011_burly_shinko_yamashiro.sql",root),"utf8"),
  ]);
  assert.match(english,/\/api\/daily-report/);
  assert.match(english,/ONE TRADING DAY · ONE VERIFIED CLOSE/);
  assert.match(english,/OTC Filing Watch/);
  assert.match(english,/Hong Kong listings are not included/);
  assert.match(english,/\/en\/company/);
  assert.match(englishDetail,/\/api\/events/);
  assert.match(englishDetail,/Verification and source evidence/);
  assert.match(englishDetail,/route\("shareholder"/);
  assert.match(englishDetail,/Mainland China A shares/);
  assert.match(englishLanguage,/document\.documentElement\.lang = "en"/);
  assert.match(englishCompany,/kind="company"/);
  assert.match(pricing,/\/api\/billing\/checkout/);
  assert.match(pricing,/Global Filing Intelligence/);
  assert.match(pricing,/Payment details are collected by Stripe Checkout/);
  assert.match(billingMigration,/CREATE TABLE `billing_account`/);
  assert.match(billingMigration,/CREATE TABLE `billing_event`/);
});

test("deployment bundle exists", async () => {
  await access(new URL("dist/server/index.js", root));
  await access(new URL(".openai/hosting.json", root));
  const [cronWorker,cronConfig]=await Promise.all([
    readFile(new URL("scheduler/pledge-daily-cron/src/index.mjs",root),"utf8"),
    readFile(new URL("scheduler/pledge-daily-cron/wrangler.toml",root),"utf8"),
  ]);
  assert.match(cronWorker,/PRODUCTION_CRON_SECRET/);
  assert.match(cronWorker,/cloudflare-durable-object-alarm/);
  assert.match(cronConfig,/hbf-pledge-daily-scheduler/);
  assert.match(cronConfig,/PLEDGE_SCHEDULER/);
  assert.match(cronConfig,/new_sqlite_classes = \["PledgeScheduler"\]/);
  assert.doesNotMatch(cronConfig,/\[triggers\]/);
  assert.match(cronWorker,/setAlarm/);
  assert.match(cronWorker,/\/start/);
  assert.match(cronWorker,/outside-production-window/);
  assert.doesNotMatch(cronConfig,/PRODUCTION_CRON_SECRET\s*=/);
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
  assert.match(brief, /DailyReportClient/);
  assert.match(match, /让真实项目与真实资金偏好相遇/);
  assert.match(match, /联系方式默认不公开/);
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
  assert.match(quality, /只有三所均完成且未解决差异为零，才能声明当日清单完整/);
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
  assert.match(await readFile(new URL("drizzle/0013_rare_purifiers.sql",root),"utf8"),/CREATE TABLE `daily_report`/);
});
