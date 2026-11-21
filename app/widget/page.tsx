import type { Metadata } from "next";
import WidgetSetup from "./setup";

export const metadata: Metadata = { title: "Widgetul Argus", description: "Echipa Argus pe ecranul iPhone-ului" };

export default function Page() {
  return <WidgetSetup />;
}
