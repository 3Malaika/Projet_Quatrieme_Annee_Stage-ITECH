import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type ConversationSummary } from "@/lib/api";

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
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/conversations"],
    queryFn: () => api.get<ConversationSummary[]>("/api/conversations"),
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter(
      (c) =>
        !q ||
        (c.nom ?? "").toLowerCase().includes(q) ||
        (c.phone ?? "").includes(q) ||
        (c.client_id ?? "").toLowerCase().includes(q) ||
        (c.besoins ?? []).some((b) => b.toLowerCase().includes(q)),
    );
  }, [data, search]);

  return (
    <div>
      <PageHeader title="Conversations" description="Clients ayant écrit à la boutique." />

      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher par nom ou numéro"
          className="bg-card pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aucune conversation à afficher.
        </p>
      ) : (
        <div className="space-y-3">
          {list.map((c) => (
            <Link
              key={c.phone}
              to="/conversations/$phone"
              params={{ phone: c.phone }}
              className="flex items-center gap-4 rounded-xl border border-border/70 bg-card p-4 shadow-sm transition-colors hover:border-accent"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-bold text-primary">{c.nom || c.phone}</p>
                  {c.client_id && (
                    <span className="font-mono text-xs text-muted-foreground">{c.client_id}</span>
                  )}
                  {!c.nom ? (
                    <Badge className="bg-accent text-accent-foreground">Nom inconnu</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{c.messageCount} messages</span>
                </div>
                {/* Dernier besoin connu */}
                {c.besoins && c.besoins.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.besoins.map((b, i) => (
                      <span
                        key={i}
                        className="inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground capitalize"
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                ) : null}
                {c.lastMessage ? (
                  <p className="mt-1 truncate text-sm text-foreground/70">{c.lastMessage}</p>
                ) : null}
              </div>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}