import type { Metadata } from "next";
import "./globals.css";
import "./extra.css";

export const metadata: Metadata = {
  title: "HBF质押日报｜每日A股质押关账报告与融资撮合",
  description: "每日20:00固定当日日报范围，20:00后公告顺延到下一自然日，周末照常发布经三所交叉核验的A股质押图片与PDF报告。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
