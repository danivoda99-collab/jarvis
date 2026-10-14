import { isAuthenticated } from "@/lib/auth";
import Jarvis from "./jarvis";
import Login from "./login";

export const dynamic = "force-dynamic";

export default async function Home() {
  return (await isAuthenticated()) ? <Jarvis /> : <Login />;
}
