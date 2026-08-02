"use client";

import { useEffect } from "react";

export default function EnglishLanguage({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = "en";
    return () => { document.documentElement.lang = previous; };
  }, []);
  return children;
}
