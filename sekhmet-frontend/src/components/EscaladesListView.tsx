import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Escalade } from "@/lib/api";
import { useNotifications, sendLocalNotification } from "@/hooks/useNotifications";

function formatDate(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

// Extrait de routes/escalades.tsx pour être réutilisable à la fois par la
// page desktop dédiée (/escalades) et par l'onglet "Chat" fusionné affiché
// sur mobile (/chat) — même logique, aucune duplication.
export function EscaladesListView() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"tous" | "en_attente" | "cloturee">("tous");
  const [replyTo, setReplyTo] = useState<string | number | null>(null);
  const [message, setMessage] = useState("");
  const { status: notificationPermission, request: requestNotifications } = useNotifications();
  const notifiedIds = useRef<Set<string>>(new Set());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/escalades"],
    queryFn: () => api.get<Escalade[]>("/api/escalades"),
    refetchInterval: 30_000, // polling toutes les 30s pour détecter les nouvelles escalades
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const requestPhoneNotifications = async () => {
    const s = await requestNotifications();
    if (s === "granted") toast.success("Notifications activées !");
    else if (s === "denied") toast.error("Permission refusée.");
  };

  useEffect(() => {
    if (!data || notificationPermission !== "granted") return;
    data.filter((e) => e.status === "en_attente").forEach((escalade) => {
      const id = String(escalade.id);
      if (notifiedIds.current.has(id)) return;
      notifiedIds.current.add(id);
      sendLocalNotification(
        "Nouvelle escalade",
        `${escalade.from} : ${escalade.userMessage}`,
        typeof escalade.id === "number" ? escalade.id : parseInt(id, 10) || 1
      );
    });
  }, [data, notificationPermission]);

  const list = useMemo(() => {
    const sorted = [...(data ?? [])].sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    );
    if (filter === "tous") return sorted;
    if (filter === "en_attente") return sorted.filter((e) => e.status === "en_attente");
    return sorted.filter((e) => e.status !== "en_attente");
  }, [data, filter]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/escalades"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  };

  const cloturer = useMutation({
    mutationFn: (id: string | number) => api.patch(`/api/escalades/${id}/cloturer`),
    onSuccess: () => {
      toast.success("Escalade marquée comme résolue.");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const repondre = useMutation({
    mutationFn: (id: string | number) => api.post(`/api/escalades/${id}/repondre`, { message }),
    onSuccess: () => {
      toast.success("Réponse envoyée au client.");
      setReplyTo(null);
      setMessage("");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      {notificationPermission !== "granted" ? (
        <button className="phone-notification-button" onClick={requestPhoneNotifications}>
          <Bell />
          {notificationPermission === "unsupported" ? "Notifications téléphone indisponibles" : "Activer les notifications sur ce téléphone"}
        </button>
      ) : (
        <p className="phone-notification-status"><Bell /> Notifications téléphone activées</p>
      )}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)} className="mb-6">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="tous" className="flex-1 sm:flex-none">
            Tous
          </TabsTrigger>
          <TabsTrigger value="en_attente" className="flex-1 sm:flex-none">
            En attente
          </TabsTrigger>
          <TabsTrigger value="cloturee" className="flex-1 sm:flex-none">
            Clôturées
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aucune escalade à afficher.
        </p>
      ) : (
        <div className="space-y-4">
          {list.map((esc) => {
            const enAttente = esc.status === "en_attente";
            const echecEnvoi = esc.status === "echec_envoi";
            return (
              <Card key={esc.id} className="rounded-xl border-border/70 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-primary">{esc.from}</p>
                    <Badge
                      className={
                        enAttente
                          ? "bg-accent text-accent-foreground"
                          : "bg-muted text-muted-foreground"
                      }
                    >
                      {enAttente ? "En attente" : echecEnvoi ? "Échec d'envoi" : "Clôturée"}
                    </Badge>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
                    {esc.userMessage}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatDate(esc.createdAt)}
                    {esc.closedAt ? ` · clôturée le ${formatDate(esc.closedAt)}` : ""}
                  </p>
                  {esc.lastDeliveryError ? (
                    <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive break-words">
                      L'envoi au contact d'escalade a échoué : {esc.lastDeliveryError}
                    </p>
                  ) : null}

                  {enAttente ? (
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <Button
                        variant="outline"
                        onClick={() => cloturer.mutate(esc.id)}
                        disabled={cloturer.isPending}
                      >
                        <Check className="size-4" />
                        Marquer comme résolu
                      </Button>
                      <Button
                        onClick={() => {
                          setReplyTo(replyTo === esc.id ? null : esc.id);
                          setMessage("");
                        }}
                      >
                        <Send className="size-4" />
                        Répondre au client
                      </Button>
                    </div>
                  ) : null}

                  {replyTo === esc.id ? (
                    <div className="mt-4 space-y-3">
                      <Textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Votre réponse au client..."
                        className="min-h-40 resize-y bg-card text-sm leading-relaxed"
                      />
                      <div className="flex justify-end">
                        <Button
                          onClick={() => repondre.mutate(esc.id)}
                          disabled={repondre.isPending || message.trim() === ""}
                          className="w-full sm:w-auto"
                        >
                          {repondre.isPending ? "Envoi..." : "Envoyer"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
