import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A股事件库｜公开披露事件数据库",
  description: "基于官方公告的 A 股事件结构化数据平台，支持查询、溯源与导出。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
