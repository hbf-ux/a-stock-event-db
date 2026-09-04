import type { Metadata } from "next";
import "./globals.css";
import "./extra.css";

export const metadata: Metadata = {
  title: "HBF质押日报｜每日A股质押关账报告与融资撮合",
  description: "HBF每日整理A股新增质押官方公告，完成三所交叉核验后生成适合公众号与小红书发布的轻量日报图片。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
