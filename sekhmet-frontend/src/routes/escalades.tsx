import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/AppLayout";
import { EscaladesListView } from "@/components/EscaladesListView";
import { ConfigurationBotPanel } from "@/components/ConfigurationBotPanel";

export const Route = createFileRoute("/escalades")({
  head: () => ({
    meta: [
      { title: "Escalades — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Traitez les demandes clients escaladées par l'agent WhatsApp Sekhmet Shop.",
      },
      { property: "og:title", content: "Escalades — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Répondez et clôturez les escalades clients en attente.",
      },
    ],
  }),
  component: EscaladesPage,
});

function EscaladesPage() {
  return (
    <div>
      <PageHeader title="Escalades" description="Demandes transmises à un humain." />
      <EscaladesListView />
      <div className="mt-10"><ConfigurationBotPanel /></div>
    </div>
  );
}
