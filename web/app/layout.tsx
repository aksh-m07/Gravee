import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Graveyard Shift",
  description: "The night guard that knows when your AI agent has stopped making progress. Goal-aware interception and recovery for browser agents.",
};
export const viewport: Viewport = { themeColor: "#0a0c0f", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
