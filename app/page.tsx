import { isAuthenticated } from "@/lib/auth";
import { googleConnected } from "@/lib/google";
import { spotifyConnected } from "@/lib/spotify";
import Jarvis from "./jarvis";
import Login from "./login";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isAuthenticated())) return <Login />;
  return <Jarvis googleConnected={await googleConnected()} spotifyConnected={await spotifyConnected()} />;
}
