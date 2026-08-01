import type { Metadata } from "next";
import PricingClient from "./pricing-client";

export const metadata:Metadata={title:"质押雷达专业版｜A股质押风控情报订阅",description:"订阅A股股东质押即时情报、历史融资分析、机构研究工作流与跨市场公告情报。"};
export default function PricingPage(){return <PricingClient locale="zh"/>;}
