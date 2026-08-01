import type { Metadata } from "next";
import EnglishIntelligence from "./en-client";

export const metadata:Metadata={title:"Pledge Radar | A-share Shareholder Finance Risk Intelligence",description:"Live, traceable intelligence on A-share shareholder pledges, releases and financing risk signals from official Chinese disclosures."};
export default function EnglishPage(){return <EnglishIntelligence/>;}
