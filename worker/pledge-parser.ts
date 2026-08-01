export type SectionPledgeRow = {
  shareholder: string;
  pledgee: string;
  amount: number;
  amountText: string;
  pledgeRatio: string;
  totalRatio: string;
  startDate: string;
  endDate: string;
  purpose: string;
  type: "新增质押" | "补充质押" | "解除质押" | "解除后再质押";
  missing: string[];
};

type ValidatablePledgeRow = {
  shareholder: string;
  pledgee: string;
  amount: number;
  amountText: string;
  pledgeRatio?: string;
  totalRatio?: string;
  type: string;
  missing: string[];
};

const institutionSuffix = /(?:银行股份有限公司(?:[^公司]{0,20}支行)?|证券股份有限公司|信托有限公司|融资租赁有限公司|资产管理有限公司|有限责任公司|有限公司)$/;
const genericInstitutions = new Set(["有限公司","有限责任公司","股份有限公司","银行股份有限公司","证券股份有限公司","信托有限公司","科技有限公司","投资有限公司"]);

export function normalizePledgeEntity(value: string, kind: "shareholder" | "pledgee") {
  let normalized = String(value || "").replace(/[\s\u00a0]+/g, "").replace(/^[，。；;：:、]+|[，。；;：:、]+$/g, "");
  if (kind === "shareholder") normalized = normalized.replace(/^(?:申请人等|申请人|出质人)(?=[\u4e00-\u9fff（）()·]{2,})/,"");
  if (kind === "pledgee") {
    normalized = normalized.replace(/^为准[）)]/,"");
    if (/^[日止][\u4e00-\u9fff（）()·]{4,}/.test(normalized) && institutionSuffix.test(normalized.slice(1))) normalized = normalized.slice(1);
  }
  return normalized;
}

export function validateAndNormalizePledgeRow<T extends ValidatablePledgeRow>(input: T): T {
  const row = {
    ...input,
    shareholder: normalizePledgeEntity(input.shareholder,"shareholder"),
    pledgee: normalizePledgeEntity(input.pledgee,"pledgee"),
    amountText: String(input.amountText || "").replace(/[\s\u00a0]+/g," ").trim(),
    pledgeRatio: String(input.pledgeRatio || "").replace(/[\s\u00a0]+/g,""),
    totalRatio: String(input.totalRatio || "").replace(/[\s\u00a0]+/g,""),
  } as T;
  const invalidShareholder = row.shareholder.length < 2
    || /^(股东|名称|合计|本次|质押|融资|借款)$/.test(row.shareholder)
    || /(补充流动资金|融资资金用途|偿还借款|质押用途)/.test(row.shareholder)
    || /^(?:科技|投资|资产管理|控股)?(?:有限责任|股份)?公司$/.test(row.shareholder);
  const invalidPledgee = row.pledgee.length < 3
    || /^(占其|占公司|质押数量|比例|本次|股东|名称|合计|上表|本表|根据)/.test(row.pledgee)
    || /证券登记结算/.test(row.pledgee)
    || genericInstitutions.has(row.pledgee)
    || !institutionSuffix.test(row.pledgee);
  const compactAmount = row.amountText.replace(/\s+/g,"");
  const invalidAmountText = !/^(?:\d+(?:\.\d+)?(?:万|亿)?股?|\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:万|亿)?股?)$/.test(compactAmount);
  const invalidRatio = [row.pledgeRatio,row.totalRatio].some((value) => value && (!/^\d{1,3}(?:\.\d+)?%$/.test(value) || Number(value.slice(0,-1)) > 100 || /^0\d/.test(value)));
  const disclosedRatio = Number((row.pledgeRatio || "").replace("%",""));
  const implausibleAmountRatio = row.amount < 10000 && Number.isFinite(disclosedRatio) && disclosedRatio >= 1;
  const invalidType = !["新增质押","补充质押","解除质押","解除后再质押"].includes(row.type);
  row.missing = [
    (!row.shareholder || invalidShareholder) && "股东",
    (!row.pledgee || invalidPledgee) && "质权人",
    (!row.amount || !Number.isFinite(row.amount) || row.amount <= 0 || invalidAmountText || implausibleAmountRatio) && "质押数量",
    invalidRatio && "质押比例",
    invalidType && "事件类型",
  ].filter(Boolean) as string[];
  return row;
}

const compact = (value: string) => value.replace(/\s+/g, "").trim();
const amountNumber = (value: string) => {
  const numeric = Number(value.replace(/,/g, "").match(/[\d.]+/)?.[0] || 0);
  if (/亿/.test(value)) return numeric * 100000000;
  if (/万/.test(value)) return numeric * 10000;
  return numeric;
};

const normalizeDate = (value: string) => value.replace(/\s+/g, "").replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "").replace(/\./g, "-");

function cleanShareholder(raw: string) {
  let value = compact(raw);
  value = value.replace(/^.*(?:质押融资资金用途|融资资金用途|资金用途|是否补充质押|股东名称)/, "");
  value = value.replace(/^(?:情况|如下|合计|名称|补充质押|偿还债务|置换前期融资)+/, "");
  value = value.replace(/^.*(?:融资提供担保|提供担保|担保)/, "");
  if (/(融资|担保|用途)/.test(value)) value = value.match(/([\u4e00-\u9fff·]{2,4})$/)?.[1] || value;
  if (value.length > 45 || /(?:质权人|到期日|起始日|股份比例|股本比例)/.test(value)) return "";
  return value;
}

function findPledgee(tail: string) {
  const value = compact(tail);
  const patterns = [
    /[\u4e00-\u9fff（）()]{2,70}银行股份有限公司[\u4e00-\u9fff]{0,20}支行/,
    /[\u4e00-\u9fff（）()]{2,70}(?:证券股份有限公司|银行股份有限公司|信托有限公司|投资中心（有限合伙）|有限责任公司|有限公司)/,
  ];
  let result = "";
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[0] || "";
    if (match) { result = match; break; }
  }
  return result.replace(/^.*(?:质押登记手续之日|解除登记手续为止|登记手续为止|到期日|之日|为止|否|是|日)/, "");
}

function ratiosAfterPledgee(tail: string, pledgee: string) {
  const value = compact(tail);
  const after = pledgee && value.includes(pledgee) ? value.slice(value.indexOf(pledgee) + pledgee.length) : value;
  const joinedDecimals = after.match(/^(\d{1,3}\.\d{2})(\d{1,3}\.\d{2})%/);
  if (joinedDecimals) return [`${joinedDecimals[1]}%`,`${joinedDecimals[2]}%`];
  return [...after.matchAll(/\d+(?:\.\d+)?%?/g)]
    .map((match) => match[0])
    .filter((entry) => Number(entry.replace("%", "")) <= 100)
    .slice(0, 2)
    .map((entry) => entry.endsWith("%") ? entry : `${entry}%`);
}

function parsePledgeTable(text: string, title: string): SectionPledgeRow[] {
  const start = text.search(/(?:一、)?本次股份质押(?:的基本情况|基本情况|情况)/);
  if (start < 0) return [];
  const source = text.slice(start);
  const endMatch = source.slice(8).search(/\n(?:二、|三、|2[.、]|3[.、])(?:本次股份解除质押|本次被质押|股东累计|控股股东|上市公司|其他)/);
  const section = (endMatch >= 0 ? source.slice(0, endMatch + 8) : source.slice(0, 5000)).replace(/\s+/g, " ");
  const rowPattern = /(.{2,180}?)\s+(是|否)\s+([\d,.]+\s*(?:万|亿)?\s*股?)\s+(是|否)\s+(是|否)\s+(.{20,700}?)(?=(?:[\u4e00-\u9fff（）()·]\s*){2,45}\s+(?:是|否)\s+[\d,.]+\s*(?:万|亿)?\s*股?\s+(?:是|否)\s+(?:是|否)|\s+合计\s|\s+注[：:]|$)/g;
  const rows: SectionPledgeRow[] = [];
  for (const match of section.matchAll(rowPattern)) {
    const shareholder = cleanShareholder(match[1]);
    const amountText = `${compact(match[3]).replace(/股$/, "")} 股`;
    const pledgee = findPledgee(match[6]);
    const ratios = ratiosAfterPledgee(match[6], pledgee);
    const dates = [...match[6].matchAll(/\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?/g)].map((item) => normalizeDate(item[0]));
    const amount = amountNumber(amountText);
    const type = match[5] === "是" || (title.includes("补充质押") && !title.includes("解除")) ? "补充质押" : "新增质押";
    const missing = [!shareholder && "股东", !pledgee && "质权人", !amount && "质押数量"].filter(Boolean) as string[];
    if (amount && shareholder !== "股东名称" && shareholder !== "合计") rows.push({shareholder,pledgee,amount,amountText,pledgeRatio:ratios[0] || "",totalRatio:ratios[1] || "",startDate:dates[0] || "",endDate:dates[1] || (/办理.*解除.*登记/.test(match[6]) ? "办理解除质押登记之日" : ""),purpose:"",type,missing});
  }
  return rows;
}

function parseReleaseSection(text: string): SectionPledgeRow[] {
  const matches = [...text.matchAll(/(?:股东名称\s+([^\n]{2,100})\s+)?本次(?:解除质押股份|解质股份)(?:（股）)?\s+([\d,.]+\s*(?:万|亿)?\s*股?)/g)];
  return matches.map((match) => {
    const around = text.slice(Math.max(0, match.index! - 180), Math.min(text.length, match.index! + 600));
    const shareholder = cleanShareholder(match[1] || around.match(/股东名称\s+([^\n]{2,100})/)?.[1] || "");
    const amountText = `${compact(match[2]).replace(/股$/, "")} 股`;
    const pledgee = compact(text.slice(Math.max(0, match.index! - 800), match.index!)).match(/质押给([^，。]{2,80}?(?:证券股份有限公司|银行股份有限公司|信托有限公司|有限责任公司|有限公司))的/)?.[1] || "";
    const pledgeRatio = around.match(/占其所(?:持|控制)股份比例\s*([\d.]+%)/)?.[1] || "";
    const totalRatio = around.match(/占公司总股本比例\s*([\d.]+%)/)?.[1] || "";
    const endDate = normalizeDate(around.match(/(?:解除质押时间|解质时间)\s*(\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?)/)?.[1] || "");
    const amount = amountNumber(amountText);
    const missing = [!shareholder && "股东", !pledgee && "质权人", !amount && "质押数量"].filter(Boolean) as string[];
    return {shareholder,pledgee,amount,amountText,pledgeRatio,totalRatio,startDate:"",endDate,purpose:"",type:"解除质押" as const,missing};
  });
}

export function parseSectionPledgeRows(text: string, title: string) {
  const rows = [...parsePledgeTable(text,title),...parseReleaseSection(text)];
  return rows.filter((row,index,all) => index === all.findIndex((other) => `${other.type}|${other.shareholder}|${other.pledgee}|${other.amount}` === `${row.type}|${row.shareholder}|${row.pledgee}|${row.amount}`));
}

export function isRelevantSharePledgeTitle(title: string) {
  if (!/(股份|股票|股权).{0,8}(质押|解质)|(?:质押|解质).{0,8}(股份|股票|股权)/.test(title)) return false;
  return !/(债券.*质押式回购|质押式回购.*债券|抵质押担保|知识产权质押|应收账款质押|拟签署.*质押合同|股票质押式回购交易业务)/.test(title);
}
