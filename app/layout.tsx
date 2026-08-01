import type { Metadata } from "next";
import "./globals.css";
import "./extra.css";

export const metadata: Metadata = {
  title: "质押雷达｜A股股东融资风险即时情报与尽调报告",
  description: "追踪 A 股股东质押、补充质押和解除质押，提供可回溯官方公告的公司、股东、质权人情报页与融资风控报告。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}<nav className="globalLanguageSwitch" aria-label="Language"><a href="/">中文</a><a href="/en">EN</a><a href="/pricing">订阅</a></nav></body></html>;
}
