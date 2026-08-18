import { createFileRoute } from "@tanstack/react-router";
import { Info } from "lucide-react";

import { TextDocEditor } from "@/components/TextDocEditor";

export const Route = createFileRoute("/message-accueil")({
  head: () => ({
    meta: [
      { title: "Message d'accueil — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Modifiez le message envoyé automatiquement à chaque nouveau client WhatsApp.",
      },
      { property: "og:title", content: "Message d'accueil — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Modifiez le message envoyé automatiquement à chaque nouveau client WhatsApp.",
      },
    ],
  }),
  component: () => (
    <TextDocEditor
      title="Message d'accueil"
      description="Premier message envoyé à tout nouveau client qui écrit à la boutique."
      endpoint="/api/message-ouverture"
      notice={
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/50 bg-accent/10 px-4 py-3 text-sm text-foreground/80">
          <Info className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <p>
            Ce message est envoyé automatiquement et intégralement, sans passer par l'IA — vérifiez
            bien le texte avant d'enregistrer.
          </p>
        </div>
      }
    />
  ),
});

