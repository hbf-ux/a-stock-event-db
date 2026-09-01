import assert from "node:assert/strict";
import test from "node:test";
import { isRelevantSharePledgeTitle, parseSectionPledgeRows, validateAndNormalizePledgeRow } from "../worker/pledge-parser.ts";

test("parses wrapped pledge tables and multiple rows", () => {
  const text = `一、本次股份质押情况
股东 名称 是否为控股股东 本次质押股数（股） 是否为限售股 是否补充质押 质押起始日 质押到期日 质权人 占其所持股份比例 占公司总股本比例 质押融资资金用途
通运 投资 是 3,800,000 否 是 2026 年 7 月 30 日 办理质押解除登记手续为止 国民信托 有限公司 1.80% 0.54% 补充质押
通运 投资 是 2,000,000 否 是 2026 年 7 月 30 日 办理质押解除登记手续为止 烟台华周 投资中心（有限合伙） 0.95% 0.28% 补充质押
合计 - 5,800,000`;
  const rows = parseSectionPledgeRows(text,"关于控股股东股份补充质押的公告");
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map((row) => [row.shareholder,row.pledgee,row.amount,row.type]),[
    ["通运投资","国民信托有限公司",3800000,"补充质押"],
    ["通运投资","烟台华周投资中心（有限合伙）",2000000,"补充质押"],
  ]);
});

test("keeps a confirmed pledge row when a mixed release row lacks its pledgee", () => {
  const text = `一、本次股份质押情况
股东名称 是否为控股股东 本次质押股数（股） 是否为限售股 是否补充质押 质押起始日 质押到期日 质权人 占其所持股份比例 占公司总股本比例 质押融资资金用途
伍超群 是 71,566,345 否 否 2026 年 7 月 30 日 2027 年 7 月 29 日 中国银河证券股份有限公司 13.17% 5.38% 置换前期融资
二、本次股份解除质押情况
股东名称 伍超群
本次解除质押股份（股） 48,490,000
占其所持股份比例 8.92%
占公司总股本比例 3.64%
解除质押时间 2026 年 7 月 31 日`;
  const rows = parseSectionPledgeRows(text,"关于控股股东部分股份质押的公告");
  assert.equal(rows.length,2);
  assert.equal(rows[0].amount,71566345);
  assert.equal(rows[0].pledgee,"中国银河证券股份有限公司");
  assert.deepEqual(rows[0].missing,[]);
  assert.equal(rows[1].type,"解除质押");
  assert.deepEqual(rows[1].missing,["质权人"]);
});

test("rejects non-shareholder pledge announcements", () => {
  assert.equal(isRelevantSharePledgeTitle("关于控股股东部分股份质押的公告"),true);
  assert.equal(isRelevantSharePledgeTitle("关于使用闲置资金购买债券通用质押式回购的公告"),false);
  assert.equal(isRelevantSharePledgeTitle("关于向银行申请融资提供抵质押担保的公告"),false);
  assert.equal(isRelevantSharePledgeTitle("关于拟签署证券质押合同暨关联交易的公告"),false);
  assert.equal(isRelevantSharePledgeTitle("关于子公司股权质押的公告"),false);
  assert.equal(isRelevantSharePledgeTitle("关于控股股东部分股权解除质押并继续质押的公告"),true);
});

test("normalizes safe OCR residue and rejects generic or contaminated entities", () => {
  const clean = validateAndNormalizePledgeRow({shareholder:"兰州银行股 份有限公司",pledgee:"日广州凯得融资租赁有限公司",amount:10000000,amountText:"10,000,000 股",pledgeRatio:"5.19%",totalRatio:"1.20%",type:"新增质押",missing:[]});
  assert.equal(clean.shareholder,"兰州银行股份有限公司");
  assert.equal(clean.pledgee,"广州凯得融资租赁有限公司");
  assert.deepEqual(clean.missing,[]);

  const generic = validateAndNormalizePledgeRow({shareholder:"补充流动资金东大针织",pledgee:"信托有限公司",amount:1000,amountText:"1,000 股",pledgeRatio:"00%",totalRatio:"",type:"新增质押",missing:[]});
  assert.deepEqual(generic.missing,["股东","质权人","质押比例"]);
});

test("rejects malformed grouped share amounts", () => {
  const row = validateAndNormalizePledgeRow({shareholder:"张三",pledgee:"天津滨海正信资产管理有限公司",amount:10000,amountText:"1,000,0 股",pledgeRatio:"1.00%",totalRatio:"0.10%",type:"新增质押",missing:[]});
  assert.deepEqual(row.missing,["质押数量"]);
});

test("rejects likely lost units and removes table-tail prefixes", () => {
  const row = validateAndNormalizePledgeRow({shareholder:"汤秀清",pledgee:"为准）渤海国际信托股份有限公司",amount:450,amountText:"450 股",pledgeRatio:"5.19%",totalRatio:"1.10%",type:"解除质押",missing:[]});
  assert.equal(row.pledgee,"渤海国际信托股份有限公司");
  assert.deepEqual(row.missing,["质押数量"]);
  const institution = validateAndNormalizePledgeRow({shareholder:"新湖智脑",pledgee:"止中信银行股份有限公司",amount:11211080,amountText:"11,211,080 股",pledgeRatio:"99.96%",totalRatio:"1.20%",type:"新增质押",missing:[]});
  assert.equal(institution.pledgee,"中信银行股份有限公司");
  assert.equal(validateAndNormalizePledgeRow({...institution,shareholder:"申请人等盛屯汇泽"}).shareholder,"盛屯汇泽");
  assert.deepEqual(institution.missing,[]);
});

test("infers 万股 from a table header and accepts common capital providers", () => {
  const text=`一、本次股份质押情况
股东名称 是否为控股股东 本次质押数量（万股） 是否为限售股 是否补充质押 质押起始日 质押到期日 质权人 占其所持股份比例 占公司总股本比例
华远控股 是 380.50 否 否 2026年7月31日 2027年7月30日 国新证券有限公司 12.50 2.15`;
  const rows=parseSectionPledgeRows(text,"关于控股股东部分股份质押的公告");
  assert.equal(rows.length,1);
  assert.equal(rows[0].amount,3805000);
  assert.equal(rows[0].amountText,"380.50万 股");
  assert.deepEqual(validateAndNormalizePledgeRow(rows[0]).missing,[]);
});

test("parses multiple release rows with header units", () => {
  const text=`一、本次股份解除质押情况
股东名称 本次解除质押股份（万股） 占其所持股份比例 占公司总股本比例 解除质押日期 质权人
王海山 120.00 6.20% 1.10% 2026年7月30日 中信证券股份有限公司
李明远 80.50 4.10% 0.72% 2026年7月31日 北京银行股份有限公司上海分行
合计 200.50`;
  const rows=parseSectionPledgeRows(text,"关于股东部分股份解除质押的公告");
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map((row)=>[row.shareholder,row.amount,row.pledgee,row.type]),[
    ["王海山",1200000,"中信证券股份有限公司","解除质押"],
    ["李明远",805000,"北京银行股份有限公司上海分行","解除质押"],
  ]);
});

test("marks a new pledge in a release-and-repledge announcement", () => {
  const text=`一、本次股份质押情况
股东名称 是否为控股股东 本次质押股数（股） 是否为限售股 是否补充质押 质押起始日 质押到期日 质权人 占其所持股份比例 占公司总股本比例
赵文华 是 5,000,000 否 否 2026年7月31日 2027年7月31日 国民信托有限公司 10.00% 2.00%`;
  const rows=parseSectionPledgeRows(text,"关于控股股东股份解除质押及再质押的公告");
  assert.equal(rows[0].type,"解除后再质押");
});

test("accepts limited-partnership pledgees", () => {
  const row=validateAndNormalizePledgeRow({shareholder:"通运投资",pledgee:"烟台华周投资中心（有限合伙）",amount:2000000,amountText:"2,000,000 股",pledgeRatio:"0.95%",totalRatio:"0.28%",type:"补充质押",missing:[]});
  assert.deepEqual(row.missing,[]);
});
