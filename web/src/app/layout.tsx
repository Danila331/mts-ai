import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Geist — рабочий гротеск интерфейса с кириллицей; Geist Mono — только id, числа в данных, промпт и JSON.
const sans = Geist({ variable: "--font-geist", subsets: ["latin", "cyrillic"], display: "swap" });
// Моноширинный не нужен для первого экрана — не предзагружаем, он подтянется по месту.
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "cyrillic"], display: "swap", preload: false });

export const metadata: Metadata = {
  title: "EnergyTool AI — ИИ-консультант МТС",
  description: "Тестовый стенд ИИ-консультанта МТС EnergyTool: чат, отладка RAG, база знаний и виджет для сайта",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#151618" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={`${sans.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider delay={300}>{children}</TooltipProvider>
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
