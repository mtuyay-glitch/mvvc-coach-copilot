import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MVVC Coach Copilot",
  description: "Coach-friendly Q&A powered by team stats",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
