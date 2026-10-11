import type { Metadata, Viewport } from "next";
import "./globals.css";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Mint Rebuild — Free Budgets",
  description:
    "Free, local-first Mint-like PWA: your data stays on your device. Manual expenses, budgets, on-device receipt OCR.",
  applicationName: "Mint Rebuild",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Mint Rebuild",
  },
  formatDetection: { telephone: false },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#059669",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className="min-h-dvh antialiased">
        <div className="mx-auto min-h-dvh max-w-lg pb-24">
          <header className="sticky top-0 z-40 border-b border-emerald-800/10 bg-emerald-600 px-4 py-3 text-white shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-emerald-100">
                  Free · No ads
                </p>
                <h1 className="text-lg font-bold leading-tight">Mint Rebuild</h1>
              </div>
              <div className="flex gap-2">
                <Link href="/categories/" className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium backdrop-blur hover:bg-white/25">
                  Categories
                </Link>
                <Link href="/backup/" className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium backdrop-blur hover:bg-white/25">
                  Backup
                </Link>
              </div>
            </div>
          </header>
          <AppShell />
          <main className="px-4 py-4">{children}</main>
        </div>
        <Nav />
      </body>
    </html>
  );
}
