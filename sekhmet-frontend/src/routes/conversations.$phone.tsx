import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil } from "lucide-react";
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

function ConversationDetailPage() {
  const { phone } = Route.useParams();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [nom, setNom] = useState("");
  const [besoin, setBesoin] = useState("");

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
      setBesoin(data.besoin ?? "");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put(`/api/clients/${encodeURIComponent(phone)}`, { nom, besoin }),
    onSuccess: () => {
      toast.success("Client mis à jour.");
      setEditOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", phone] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <Link
        to="/conversations"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-primary"
      >
        <ArrowLeft className="size-4" />
        Retour aux conversations
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-primary md:text-2xl">{data?.nom || phone}</h1>
            {data && !data.nom ? (
              <Badge className="bg-accent text-accent-foreground">Nom inconnu</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {data?.besoin ? data.besoin : "Besoin non identifié"}
          </p>
          {data?.nom ? <p className="text-xs text-muted-foreground">{phone}</p> : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
          Modifier
        </Button>
      </div>

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
          {data && data.messages.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Aucun message dans cette conversation.
            </p>
          ) : null}
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-primary">Modifier le client</DialogTitle>
            <DialogDescription>Corrigez le nom ou le besoin du client.</DialogDescription>
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
              <Input id="client-nom" value={nom} onChange={(e) => setNom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-besoin">Besoin</Label>
              <Input
                id="client-besoin"
                value={besoin}
                onChange={(e) => setBesoin(e.target.value)}
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
