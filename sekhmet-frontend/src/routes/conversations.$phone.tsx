import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type ConversationDetail } from "@/lib/api";

export const Route = createFileRoute("/conversations/$phone")({
  head: () => ({
    meta: [
      { title: "Détail conversation — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Historique complet des messages échangés avec un client Sekhmet Shop.",
      },
      { property: "og:title", content: "Détail conversation — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Historique complet des messages échangés avec un client Sekhmet Shop.",
      },
    ],
  }),
  component: ConversationDetailPage,
});

function formatDate(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function ConversationDetailPage() {
  const { phone } = Route.useParams();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [nom, setNom] = useState("");
  const [nouveauBesoin, setNouveauBesoin] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/conversations", phone],
    queryFn: () => api.get<ConversationDetail>(`/api/conversations/${encodeURIComponent(phone)}`),
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  useEffect(() => {
    if (data) {
      setNom(data.nom ?? "");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/clients/${encodeURIComponent(phone)}`, {
        nom,
        ...(nouveauBesoin.trim() ? { besoin: nouveauBesoin.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success("Client mis à jour.");
      setEditOpen(false);
      setNouveauBesoin("");
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", phone] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const besoins = data?.besoins ?? [];
  const contacts_at = data?.contacts_at ?? [];

  return (
    <div>
      <Link
        to="/conversations"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-primary"
      >
        <ArrowLeft className="size-4" />
        Retour aux conversations
      </Link>

      {/* Fiche client */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-primary md:text-2xl">{data?.nom || phone}</h1>
            {data?.client_id && (
              <Badge className="bg-primary/10 text-primary font-mono text-xs">
                {data.client_id}
              </Badge>
            )}
            {data && !data.nom && (
              <Badge className="bg-accent text-accent-foreground">Nom inconnu</Badge>
            )}
          </div>
          {data?.nom && (
            <p className="mt-0.5 text-xs text-muted-foreground">{phone}</p>
          )}

          {/* Historique des besoins */}
          {besoins.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Historique des besoins
              </p>
              <div className="flex flex-col gap-1.5">
                {besoins.map((besoin, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground capitalize">
                      {besoin}
                    </span>
                    {contacts_at[i] && (
                      <span className="text-xs text-muted-foreground">
                        {formatDate(contacts_at[i])}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Besoin non identifié</p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
          Modifier
        </Button>
      </div>

      {/* Messages */}
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {(data?.messages ?? []).map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-sm bg-bubble-user px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm"
                    : "max-w-[85%] rounded-2xl rounded-bl-sm border border-border/60 bg-bubble-assistant px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm"
                }
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {m.content}
              </div>
            </div>
          ))}
          {data && data.messages.length === 0 && (
            <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Aucun message dans cette conversation.
            </p>
          )}
        </div>
      )}

      {/* Dialog modifier client */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-primary">Modifier le client</DialogTitle>
            <DialogDescription>
              Corrigez le nom ou ajoutez un besoin à l'historique.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="client-nom">Nom</Label>
              <Input
                id="client-nom"
                value={nom}
                onChange={(e) => setNom(e.target.value)}
              />
            </div>

            {/* Historique actuel */}
            {besoins.length > 0 && (
              <div className="space-y-1.5">
                <Label>Besoins enregistrés</Label>
                <div className="flex flex-wrap gap-1.5">
                  {besoins.map((b, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground capitalize"
                    >
                      {b}
                      {contacts_at[i] && (
                        <span className="text-muted-foreground">· {formatDate(contacts_at[i])}</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Ajouter un besoin */}
            <div className="space-y-2">
              <Label htmlFor="nouveau-besoin" className="flex items-center gap-1">
                <Plus className="size-3" />
                Ajouter un besoin
              </Label>
              <Input
                id="nouveau-besoin"
                value={nouveauBesoin}
                onChange={(e) => setNouveauBesoin(e.target.value)}
                placeholder="formation, suivi alimentaire, produits finis..."
              />
            </div>

            <DialogFooter>
              <Button type="submit" disabled={save.isPending} className="w-full sm:w-auto">
                {save.isPending ? "Enregistrement..." : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
