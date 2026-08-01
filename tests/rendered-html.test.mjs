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
  assert.match(worker, /manual-review-v1/);
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
  assert.match(worker, /双方分别确认前不返回对方机构/);
  assert.match(worker, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(worker, /rules-then-openai/);
  assert.match(worker, /maxAutomaticAttempts: 2/);
  assert.match(worker, /parseSectionPledgeRows/);
  assert.match(worker, /openai_quota_blocked_until/);
  assert.doesNotMatch(worker, /await seed\(env\.DB\)/);
  assert.match(layout, /A股股东融资风险即时情报与尽调报告/);
});

test("deployment bundle exists", async () => {
  await access(new URL("dist/server/index.js", root));
  await access(new URL(".openai/hosting.json", root));
});

test("commercial intelligence pages are wired to verified event data", async () => {
  const [detail, company, shareholder, pledgee, event, capital, brief, match, matchDesk, migration, matchMigration] = await Promise.all([
    readFile(new URL("app/intelligence-detail.tsx", root), "utf8"),
    readFile(new URL("app/company/[code]/page.tsx", root), "utf8"),
    readFile(new URL("app/shareholder/[name]/page.tsx", root), "utf8"),
    readFile(new URL("app/pledgee/[name]/page.tsx", root), "utf8"),
    readFile(new URL("app/event/[id]/page.tsx", root), "utf8"),
    readFile(new URL("app/capital/page.tsx", root), "utf8"),
    readFile(new URL("app/brief/page.tsx", root), "utf8"),
    readFile(new URL("app/match/page.tsx", root), "utf8"),
    readFile(new URL("app/match/desk/page.tsx", root), "utf8"),
    readFile(new URL("drizzle/0004_past_franklin_storm.sql", root), "utf8"),
    readFile(new URL("drizzle/0007_free_guardian.sql", root), "utf8"),
  ]);
  assert.match(detail, /质押事件时间线/);
  assert.match(detail, /完整股东融资风控报告/);
  assert.match(detail, /内测预约，不会产生扣费/);
  assert.match(detail, /官方原文/);
  assert.match(company, /kind="company"/);
  assert.match(shareholder, /kind="shareholder"/);
  assert.match(pledgee, /kind="pledgee"/);
  assert.match(event, /kind="event"/);
  assert.match(capital, /融资活跃度，不是信用评分/);
  assert.match(capital, /事件差，不是存量质押/);
  assert.match(brief, /A股质押情报简报/);
  assert.match(brief, /打印简报/);
  assert.match(match, /让真实融资需求与真实资金偏好相遇/);
  assert.match(match, /联系方式不会公开/);
  assert.match(match, /不承诺融资结果/);
  assert.match(matchDesk, /我的撮合进度/);
  assert.match(matchDesk, /双方确认前/);
  assert.match(migration, /CREATE TABLE `match_request`/);
  assert.match(matchMigration, /CREATE TABLE `match_candidate`/);
});
