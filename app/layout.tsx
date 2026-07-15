import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Orchestrato.AI",
  description:
    "Plateforme de gestion de projet pilotée par orchestration dynamique d'IA.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
