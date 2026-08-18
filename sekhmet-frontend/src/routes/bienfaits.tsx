import { createFileRoute } from "@tanstack/react-router";

import { TextDocEditor } from "@/components/TextDocEditor";

export const Route = createFileRoute("/bienfaits")({
  head: () => ({
    meta: [
      { title: "Bienfaits — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Éditez la fiche des bienfaits produits utilisée par l'agent WhatsApp.",
      },
      { property: "og:title", content: "Bienfaits — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Éditez la fiche des bienfaits produits utilisée par l'agent WhatsApp.",
      },
    ],
  }),
  component: () => (
    <TextDocEditor
      title="Bienfaits"
      description="Texte de référence sur les bienfaits des produits, utilisé par l'agent."
      endpoint="/api/bienfaits"
    />
  ),
});

