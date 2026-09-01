import type { Metadata } from "next";
import EnglishIntelligence from "./en-client";

export const metadata:Metadata={title:"HBF Daily Pledge Report | A-share Closing Report",description:"A single verified A-share pledge closing report published after 20:00 China Standard Time, with source evidence and financing matchmaking."};
export default function EnglishPage(){return <EnglishIntelligence/>;}
