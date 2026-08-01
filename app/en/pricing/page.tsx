import type { Metadata } from "next";
import PricingClient from "../../pricing/pricing-client";

export const metadata:Metadata={title:"Pledge Radar Plans | A-share Financing Risk Intelligence",description:"Subscribe to verified A-share shareholder pledge intelligence and cross-market filing research."};
export default function EnglishPricingPage(){return <PricingClient locale="en"/>;}
