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
  assert.match(page, /\/api\/announcements\/\$\{row\.announcementId\}\/process/);
  assert.match(worker, /from "unpdf"/);
  assert.match(worker, /async function processAnnouncement/);
  assert.match(worker, /parse_status='parsed'/);
  assert.match(worker, /manual-review-v1/);
  assert.match(worker, /review already completed/);
  assert.match(worker, /completed_with_errors/);
  assert.match(worker, /application\/vnd\.ms-excel/);
  assert.match(worker, /p\.shareholder LIKE/);
  assert.match(worker, /ctx\.waitUntil\(processPendingQueue/);
  assert.match(worker, /parse_status IN \('queued','archived'\)/);
  assert.doesNotMatch(worker, /await seed\(env\.DB\)/);
  assert.match(layout, /A股事件库/);
});

test("deployment bundle exists", async () => {
  await access(new URL("dist/server/index.js", root));
  await access(new URL(".openai/hosting.json", root));
});
