import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckSquare, ChevronRight, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, deleteClientCascade, errorMessage, type ConversationSummary } from "@/lib/api";

// Extrait de routes/conversations.index.tsx pour être réutilisable à la
// fois par la page desktop dédiée (/conversations) et par l'onglet "Chat"
// fusionné affiché sur mobile (/chat) — même logique, même requête
// (dédupliquée par React Query via la queryKey), pas de duplication.
export function ConversationsListView() {
  const [search, setSearch] = useState("");
  // Client visé par la confirmation de suppression individuelle en cours
  // (null = aucune boîte de dialogue ouverte).
  const [clientToDelete, setClientToDelete] = useState<ConversationSummary | null>(null);
  // Mode sélection multiple : affiche une case à cocher par ligne au lieu
  // de naviguer vers la conversation au clic.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Portée de la suppression groupée en attente de confirmation (null =
  // aucune boîte de dialogue groupée ouverte). On y met soit les clients
  // sélectionnés, soit toute la liste actuellement affichée (bouton
  // "Tout supprimer"), pour n'avoir qu'une seule boîte de dialogue à gérer.
  const [bulkTargets, setBulkTargets] = useState<ConversationSummary[] | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/conversations"],
    queryFn: () => api.get<ConversationSummary[]>("/api/conversations"),
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const invalidateAfterDelete = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/paniers"] });
    queryClient.invalidateQueries({ queryKey: ["/api/escalades"] });
  };

  // Suppression EN CASCADE (panier, paiement en attente, historique, fiche
  // client) — voir DELETE /api/clients/:phone côté backend. Distincte d'un
  // simple effacement d'historique, non proposé ici (voir la page détail
  // /conversations/$phone pour ce choix plus fin).
  const deleteClient = useMutation({
    mutationFn: (phone: string) => deleteClientCascade(phone),
    onSuccess: () => {
      toast.success("Client supprimé définitivement.");
      setClientToDelete(null);
      invalidateAfterDelete();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Suppression groupée : chaque client est supprimé indépendamment
  // (Promise.allSettled) pour qu'un échec isolé (ex: un numéro déjà
  // supprimé entre-temps) n'empêche pas les autres suppressions d'aboutir.
  const bulkDelete = useMutation({
    mutationFn: async (targets: ConversationSummary[]) => {
      const results = await Promise.allSettled(
        targets.map((c) => deleteClientCascade(c.phone)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      return { total: targets.length, failed };
    },
    onSuccess: ({ total, failed }) => {
      if (failed > 0) {
        toast.error(
          `${total - failed} client(s) supprimé(s), ${failed} échec(s). Réessayez pour les clients restants.`,
        );
      } else {
        toast.success(`${total} client(s) supprimé(s) définitivement.`);
      }
      setBulkTargets(null);
      setSelected(new Set());
      setSelectionMode(false);
      invalidateAfterDelete();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter(
      (c) => !q || (c.nom ?? "").toLowerCase().includes(q) || (c.phone ?? "").includes(q),
    );
  }, [data, search]);

  const allVisibleSelected = list.length > 0 && list.every((c) => selected.has(c.phone));

  const toggleSelected = (phone: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        // Ne désélectionne que les éléments actuellement visibles (filtre
        // de recherche), pas une éventuelle sélection faite avant de filtrer.
        const next = new Set(prev);
        for (const c of list) next.delete(c.phone);
        return next;
      }
      const next = new Set(prev);
      for (const c of list) next.add(c.phone);
      return next;
    });
  };

  const selectedConversations = useMemo(
    () => (data ?? []).filter((c) => selected.has(c.phone)),
    [data, selected],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher par nom ou numéro"
            className="bg-card pl-9"
          />
        </div>
        {selectionMode ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectionMode(false);
              setSelected(new Set());
            }}
          >
            <X className="size-4" />
            Annuler
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => setSelectionMode(true)}>
              <CheckSquare className="size-4" />
              Sélectionner
            </Button>
            {list.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setBulkTargets(list)}
              >
                <Trash2 className="size-4" />
                Tout supprimer
              </Button>
            ) : null}
          </>
        )}
      </div>

      {selectionMode ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-card p-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox checked={allVisibleSelected} onCheckedChange={toggleSelectAllVisible} />
            Tout sélectionner ({list.length})
          </label>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {selected.size} sélectionné{selected.size > 1 ? "s" : ""}
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={selected.size === 0}
              onClick={() => setBulkTargets(selectedConversations)}
            >
              <Trash2 className="size-4" />
              Supprimer la sélection
            </Button>
          </div>
        </div>
      ) : null}

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
            <div
              key={c.phone}
              className="flex items-center gap-2 rounded-xl border border-border/70 bg-card p-4 shadow-sm transition-colors hover:border-accent"
            >
              {selectionMode ? (
                <Checkbox
                  checked={selected.has(c.phone)}
                  onCheckedChange={() => toggleSelected(c.phone)}
                  aria-label={`Sélectionner ${c.nom || c.phone}`}
                  className="shrink-0"
                />
              ) : null}
              {selectionMode ? (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-4 text-left"
                  onClick={() => toggleSelected(c.phone)}
                >
                  <ConversationRow c={c} />
                </button>
              ) : (
                <Link
                  to="/conversations/$phone"
                  params={{ phone: c.phone }}
                  className="flex min-w-0 flex-1 items-center gap-4"
                >
                  <ConversationRow c={c} />
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                </Link>
              )}
              {!selectionMode ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Supprimer ${c.nom || c.phone}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setClientToDelete(c);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!clientToDelete} onOpenChange={(open) => !open && setClientToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-primary">Supprimer ce client ?</AlertDialogTitle>
            <AlertDialogDescription>
              Toute la fiche de {clientToDelete?.nom || clientToDelete?.phone} sera supprimée
              définitivement : son panier en cours, tout paiement en attente de vérification, son
              adresse de livraison, l'historique de conversation, et ses informations (nom,
              besoin). Les commandes déjà facturées ne sont pas supprimées. Cette action est
              irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteClient.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (clientToDelete) deleteClient.mutate(clientToDelete.phone);
              }}
            >
              {deleteClient.isPending ? "Suppression..." : "Supprimer définitivement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!bulkTargets} onOpenChange={(open) => !open && setBulkTargets(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-primary">
              Supprimer {bulkTargets?.length} client{(bulkTargets?.length ?? 0) > 1 ? "s" : ""} ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Pour chacun : panier en cours, paiement en attente de vérification, adresse de
              livraison, historique de conversation et fiche client seront supprimés
              définitivement. Les commandes déjà facturées ne sont pas supprimées. Cette action
              est irréversible et ne peut pas être annulée en cours de route.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDelete.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (bulkTargets) bulkDelete.mutate(bulkTargets);
              }}
            >
              {bulkDelete.isPending ? "Suppression..." : "Supprimer définitivement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConversationRow({ c }: { c: ConversationSummary }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-bold text-primary">{c.nom || c.phone}</p>
        {!c.nom ? <Badge className="bg-accent text-accent-foreground">Nom inconnu</Badge> : null}
        <span className="text-xs text-muted-foreground">{c.messageCount} messages</span>
      </div>
      {c.besoin ? <p className="mt-0.5 text-sm text-muted-foreground">{c.besoin}</p> : null}
      {c.lastMessage ? (
        <p className="mt-1 truncate text-sm text-foreground/70">{c.lastMessage}</p>
      ) : null}
    </div>
  );
}
