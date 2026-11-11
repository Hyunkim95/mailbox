import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Mailbox · Your services, your terms",
  description:
    "An address and a wallet for every service. A PayPal sandbox demonstration with invented services.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
