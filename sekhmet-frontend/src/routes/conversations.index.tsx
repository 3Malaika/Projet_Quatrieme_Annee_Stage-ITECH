import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/AppLayout";
import { ConversationsListView } from "@/components/ConversationsListView";

export const Route = createFileRoute("/conversations/")({
  head: () => ({
    meta: [
      { title: "Conversations — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Consultez les échanges WhatsApp entre les clients et l'agent Sekhmet Shop.",
      },
      { property: "og:title", content: "Conversations — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Historique complet des conversations clients de la boutique.",
      },
    ],
  }),
  component: ConversationsPage,
});

function ConversationsPage() {
  return (
    <div>
      <PageHeader title="Conversations" description="Clients ayant écrit à la boutique." />
      <ConversationsListView />
    </div>
  );
}
