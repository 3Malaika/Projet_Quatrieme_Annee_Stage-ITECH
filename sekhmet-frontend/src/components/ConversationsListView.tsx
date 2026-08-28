import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type ConversationSummary } from "@/lib/api";

// Extrait de routes/conversations.index.tsx pour être réutilisable à la
// fois par la page desktop dédiée (/conversations) et par l'onglet "Chat"
// fusionné affiché sur mobile (/chat) — même logique, même requête
// (dédupliquée par React Query via la queryKey), pas de duplication.
export function ConversationsListView() {
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
      (c) => !q || (c.nom ?? "").toLowerCase().includes(q) || (c.phone ?? "").includes(q),
    );
  }, [data, search]);

  return (
    <div>
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
                  {!c.nom ? (
                    <Badge className="bg-accent text-accent-foreground">Nom inconnu</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{c.messageCount} messages</span>
                </div>
                {c.besoin ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">{c.besoin}</p>
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
