import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./tokens.css";
import "./ui/ui.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mailbox · Your services, your terms",
  description:
    "An address and a wallet for every service. A PayPal sandbox demonstration with invented services.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
