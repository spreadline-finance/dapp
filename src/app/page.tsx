import { Landing } from "@/components/landing";
import { siteOrigin, description } from "@/lib/site-metadata";
export default function Home() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Spreadline",
    url: siteOrigin.origin,
    description,
  };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    <Landing />
  </>;
}
