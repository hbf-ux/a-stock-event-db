import type { Metadata } from "next";
import "./globals.css";
import "./extra.css";

export const metadata: Metadata = {
  title: "HBF质押日报｜每日A股质押关账报告与融资撮合",
  description: "每日20:00关账，发布经三所交叉核验的A股质押图片与PDF报告，并连接资方、上市公司股东与FA的真实融资需求。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
