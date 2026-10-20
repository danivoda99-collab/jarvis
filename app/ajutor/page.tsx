import type { Metadata } from "next";
import Help from "./help";

export const metadata: Metadata = { title: "Ajutor Team Vodă", description: "Întrebări despre completarea aplicației Team Vodă" };

// Publică: o deschid oamenii din echipă din aplicația Team Vodă (?nume=… pune numele lor).
export default async function Page({ searchParams }: { searchParams: Promise<{ nume?: string }> }) {
  const { nume } = await searchParams;
  return <Help name={(nume ?? "").slice(0, 60)} />;
}
