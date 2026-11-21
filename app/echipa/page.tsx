import type { Metadata } from "next";
import { isAuthenticated } from "@/lib/auth";
import Login from "../login";
import Echipa from "./echipa";

export const metadata: Metadata = { title: "Echipa Argus", description: "Agenții lui Argus: cine lucrează, la ce, și ce așteaptă Da-ul tău" };
export const dynamic = "force-dynamic";

export default async function Page() {
  if (!(await isAuthenticated())) return <Login />;
  return <Echipa />;
}
