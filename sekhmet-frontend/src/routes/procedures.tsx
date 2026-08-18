import { createFileRoute } from "@tanstack/react-router";

import { TextDocEditor } from "@/components/TextDocEditor";

export const Route = createFileRoute("/procedures")({
  head: () => ({
    meta: [
      { title: "Procédures — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Éditez les procédures internes suivies par l'agent WhatsApp Sekhmet Shop.",
      },
      { property: "og:title", content: "Procédures — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Éditez les procédures internes suivies par l'agent WhatsApp Sekhmet Shop.",
      },
    ],
  }),
  component: () => (
    <TextDocEditor
      title="Procédures"
      description="Règles et procédures de vente appliquées par l'agent."
      endpoint="/api/procedures"
    />
  ),
});

