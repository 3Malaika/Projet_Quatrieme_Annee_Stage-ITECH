import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pencil, History, Trash2 } from "lucide-react";
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

// Libellé du séparateur de jour, façon appli de messagerie : "Aujourd'hui",
// "Hier", sinon la date complète.
function formatDayLabel(isoDate: string) {
  const day = new Date(isoDate);
  if (Number.isNaN(day.getTime())) return isoDate;

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(day, today)) return "Aujourd'hui";
  if (sameDay(day, yesterday)) return "Hier";
  return day.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

function formatTime(isoDate: string) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function formatFullDate(isoDate: string | null) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

type Message = ConversationDetail["messages"][number];

// Regroupe les messages par jour calendaire (heure locale du navigateur).
// Les messages sans horodatage (conversations démarrées avant l'ajout de ce
// champ) sont réunis sous un groupe "Historique" sans date précise, plutôt
// que d'être répartis au hasard ou de faire planter le regroupement.
function groupByDay(messages: Message[]): Array<{ label: string; items: Message[] }> {
  const withDate: Message[] = [];
  const withoutDate: Message[] = [];
  for (const m of messages) {
    (m.timestamp ? withDate : withoutDate).push(m);
  }

  const groups: Array<{ label: string; items: Message[] }> = [];
  if (withoutDate.length > 0) {
    groups.push({ label: "Historique (date inconnue)", items: withoutDate });
  }

  let currentKey = "";
  for (const m of withDate) {
    const key = (m.timestamp as string).slice(0, 10); // YYYY-MM-DD
    if (key !== currentKey) {
      groups.push({ label: formatDayLabel(m.timestamp as string), items: [] });
      currentKey = key;
    }
    groups[groups.length - 1].items.push(m);
  }

  return groups;
}

function ConversationDetailPage() {
  const { phone } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  const dayGroups = useMemo(() => groupByDay(data?.messages ?? []), [data?.messages]);
  const besoinsHistorique = data?.besoinsHistorique ?? [];

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

  const deleteHistory = useMutation({
    mutationFn: () => api.del(`/api/conversations/${encodeURIComponent(phone)}`),
    onSuccess: () => {
      toast.success("Historique effacé.");
      setDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      navigate({ to: "/conversations" });
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
        <div className="flex shrink-0 gap-2">
          {besoinsHistorique.length > 1 ? (
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History className="size-4" />
              Historique des besoins
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" />
            Modifier
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
            Effacer l'historique
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {dayGroups.map((group, gi) => (
            <div key={gi}>
              <div className="mb-3 flex items-center justify-center">
                <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize text-muted-foreground">
                  {group.label}
                </span>
              </div>
              <div className="space-y-3">
                {group.items.map((m, i) => (
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
                      {m.timestamp ? (
                        <div className="mt-1 text-right text-[10px] text-muted-foreground/70">
                          {formatTime(m.timestamp)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
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
              <p className="text-xs text-muted-foreground">
                Enregistré comme un nouveau besoin dans l'historique du client, si différent du
                précédent.
              </p>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={save.isPending} className="w-full sm:w-auto">
                {save.isPending ? "Enregistrement..." : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-primary">Historique des besoins</DialogTitle>
            <DialogDescription>
              Tous les besoins exprimés par ce client, du plus ancien au plus récent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {besoinsHistorique.map((entry, i) => (
              <div key={i} className="rounded-lg border border-border/70 bg-card p-3">
                <p className="text-sm text-foreground">{entry.besoin}</p>
                {entry.date ? (
                  <p className="mt-1 text-xs text-muted-foreground">{formatFullDate(entry.date)}</p>
                ) : null}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-primary">Effacer l'historique ?</AlertDialogTitle>
            <AlertDialogDescription>
              Tous les messages échangés avec {data?.nom || phone} seront supprimés définitivement.
              Au prochain message, ce client sera traité comme un tout nouveau contact (message
              d'accueil renvoyé). Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteHistory.isPending}
              onClick={(e) => {
                e.preventDefault();
                deleteHistory.mutate();
              }}
            >
              {deleteHistory.isPending ? "Suppression..." : "Effacer définitivement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
