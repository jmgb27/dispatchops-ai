import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DispatchOps AI — Agentic Dispatch Console",
  description:
    "Autonomous TMS exception resolution with a hard human-in-the-loop cost ceiling.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
