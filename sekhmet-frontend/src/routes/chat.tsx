import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { PageHeader } from "@/components/AppLayout";
import { ConversationsListView } from "@/components/ConversationsListView";
import { EscaladesListView } from "@/components/EscaladesListView";
import { ConfigurationBotPanel } from "@/components/ConfigurationBotPanel";
import { PaniersListView } from "@/components/PaniersListView";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "Chat — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Conversations et escalades clients de la boutique Sekhmet Shop, réunies au même endroit.",
      },
    ],
  }),
  component: ChatPage,
});

// Point d'entrée mobile qui réunit Conversations et Escalades dans un seul
// onglet de la barre de navigation (au lieu de deux onglets séparés) — les
// deux pages desktop (/conversations, /escalades) restent inchangées et
// réutilisent les mêmes composants de liste, donc aucune logique dupliquée.
function ChatPage() {
  const [tab, setTab] = useState<"conversations" | "paniers" | "escalades">("conversations");

  return (
    <div>
      <PageHeader title="Chat" description="Conversations et demandes escaladées." />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-6">
        <TabsList className="w-full">
          <TabsTrigger value="conversations" className="flex-1">
            Conversations
          </TabsTrigger>
          <TabsTrigger value="paniers" className="flex-1">
            Paniers
          </TabsTrigger>
          <TabsTrigger value="escalades" className="flex-1">
            Escalades
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "conversations" ? (
        <ConversationsListView />
      ) : tab === "paniers" ? (
        <PaniersListView />
      ) : (
        <div className="space-y-10">
          <EscaladesListView />
          <ConfigurationBotPanel />
        </div>
      )}
    </div>
  );
}
