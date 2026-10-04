import type { Metadata } from "next";
import { Sometype_Mono, Stack_Sans_Headline, Stack_Sans_Text } from "next/font/google";
import "./globals.css";

const headline = Stack_Sans_Headline({ variable: "--font-headline", subsets: ["latin"], weight: ["300", "400", "500"] });
const text = Stack_Sans_Text({ variable: "--font-text", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const mono = Sometype_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Adverse media due diligence | Keenable demo",
  description: "An agent runs adverse-media due diligence on a name with Keenable web search and writes the analyst's memo, with a full audit log.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${headline.variable} ${text.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
