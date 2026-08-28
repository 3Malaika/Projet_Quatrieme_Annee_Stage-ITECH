import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Package,
  PackageX,
  AlertTriangle,
  CheckCircle2,
  MessagesSquare,
  UserCheck,
  Archive,
  Activity,
  Zap,
  Coins,
  DollarSign,
  ShieldAlert,
  Radio,
} from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { api, errorMessage, type LogImportant, type Stats } from "@/lib/api";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tableau de bord — Sekhmet Shop Admin" },
      {
        name: "description",
        content:
          "Vue d'ensemble de la boutique Sekhmet Shop : produits, escalades et conversations WhatsApp.",
      },
      { property: "og:title", content: "Tableau de bord — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Statistiques en temps réel de l'agent WhatsApp Sekhmet Shop.",
      },
    ],
  }),
  component: Dashboard,
});

const CARDS = [
  { key: "totalProduits", label: "Total produits", icon: Package },
  { key: "produitsEnRupture", label: "Produits en rupture", icon: PackageX },
  { key: "escaladesEnAttente", label: "Escalades en attente", icon: AlertTriangle },
  { key: "escaladesCloturees", label: "Escalades clôturées", icon: CheckCircle2 },
  { key: "conversationsActives", label: "Conversations actives", icon: MessagesSquare },
  { key: "clientsIdentifies", label: "Clients identifiés", icon: UserCheck },
  { key: "appelsAujourdHui", label: "Appels Groq aujourd'hui", icon: Zap },
  { key: "tokensAujourdHui", label: "Tokens consommés aujourd'hui", icon: Coins },
] as const;

// Les compteurs de tokens peuvent vite atteindre plusieurs milliers :
// un séparateur de milliers rend la carte lisible d'un coup d'œil.
function formatStatValue(value: number) {
  return value.toLocaleString("fr-FR");
}

// Les montants Groq restent souvent sous 1$/jour à ce volume : 4 décimales
// évitent d'afficher "0,00 $" en permanence.
function formatCost(value: number | undefined) {
  if (value === undefined) return "—";
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`;
}

// Heure relative simple ("il y a 3 min") pour le panneau de logs — plus
// lisible qu'un horodatage ISO brut pour un coup d'œil rapide.
function formatRelativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

// Couleur du badge selon la source du souci — Groq et Meta/WhatsApp sont
// les deux intégrations externes critiques du flux WhatsApp, distinguées
// visuellement d'un souci "Système" plus générique.
function logBadgeClass(source: string) {
  if (source === "Groq") return "bg-accent text-accent-foreground";
  if (source === "Meta / WhatsApp") return "bg-destructive text-destructive-foreground";
  return "bg-secondary text-secondary-foreground";
}

function Dashboard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/stats"],
    queryFn: () => api.get<Stats>("/api/stats"),
  });

  const {
    data: logs,
    isLoading: logsLoading,
    isError: logsIsError,
    error: logsError,
  } = useQuery({
    queryKey: ["/api/logs"],
    queryFn: () => api.get<LogImportant[]>("/api/logs?limit=6"),
    // Rafraîchi régulièrement sans intervention : un souci Groq ou Meta doit
    // remonter vite sur le dashboard, sans que quelqu'un ait à recharger la page.
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  useEffect(() => {
    if (logsIsError) toast.error(errorMessage(logsError));
  }, [logsIsError, logsError]);

  return (
    <div>
      <PageHeader title="Tableau de bord" description="Un aperçu calme et précis de ce qui se passe dans votre boutique aujourd’hui." />
      <div className="stats-grid">
        {CARDS.map(({ key, label, icon: Icon }) => (
          <Card key={key} className="stat-card">
            <CardContent className="p-0">
              <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon"><Icon /></span></div>
                {isLoading ? (
                  <Skeleton className="mt-4 h-8 w-16" />
                ) : (
                  <p className="stat-value">{data?.[key] !== undefined ? formatStatValue(data[key]) : "—"}</p>
                )}
              <p className="stat-note">{key === "produitsEnRupture" ? "Aucun réassort à prévoir" : key === "escaladesEnAttente" ? "File de suivi claire" : key === "tokensAujourdHui" ? "Cumul de tous les appels Groq" : key === "appelsAujourdHui" ? "Réponses, extractions et résumés inclus" : "Références actives"}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="content-grid mt-3">
        <section className="panel">
          <div className="panel-header"><div><h2 className="panel-heading">Activité récente</h2><p className="panel-kicker">Les derniers signaux de votre espace</p></div><button className="text-button" onClick={() => toast.success("Activité à jour")}>Actualiser</button></div>
          <div className="activity-list">
            <div className="activity-row"><span className="activity-badge"><Archive /></span><div className="activity-copy"><strong>Catalogue synchronisé</strong><span>Les références sont disponibles</span></div><time className="activity-time">aujourd’hui</time></div>
            <div className="activity-row"><span className="activity-badge"><CheckCircle2 /></span><div className="activity-copy"><strong>Aucune escalade en attente</strong><span>La file de suivi est claire</span></div><time className="activity-time">aujourd’hui</time></div>
            <div className="activity-row"><span className="activity-badge"><MessagesSquare /></span><div className="activity-copy"><strong>Espace conversation prêt</strong><span>Les échanges clients sont suivis ici</span></div><time className="activity-time">aujourd’hui</time></div>
          </div>
        </section>
        <section className="panel insight-panel">
          <div className="panel-header"><div><h2 className="panel-heading">Point opérationnel</h2><p className="panel-kicker">Lecture rapide de la journée</p></div><Activity /></div>
          <div className="insight-body"><div className="insight-number">Stable</div><p className="insight-copy">Le catalogue est disponible et aucune demande ne requiert d’action immédiate.</p><div className="insight-rule" /></div>
        </section>
      </div>
      <div className="content-grid mt-3">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-heading">Consommation Groq</h2>
              <p className="panel-kicker">Coût estimé à partir des tarifs par modèle — indicatif, pas une facture</p>
            </div>
            <DollarSign />
          </div>
          <div className="activity-list">
            <div className="activity-row">
              <span className="activity-badge"><Zap /></span>
              <div className="activity-copy"><strong>Aujourd’hui</strong><span>{isLoading ? "…" : `${formatStatValue(data?.appelsAujourdHui ?? 0)} appels · ${formatStatValue(data?.tokensAujourdHui ?? 0)} tokens`}</span></div>
              <time className="activity-time">{isLoading ? "…" : formatCost(data?.coutEstimeAujourdHui)}</time>
            </div>
            <div className="activity-row">
              <span className="activity-badge"><Coins /></span>
              <div className="activity-copy"><strong>Ce mois-ci</strong><span>{isLoading ? "…" : `${formatStatValue(data?.appelsCeMois ?? 0)} appels · ${formatStatValue(data?.tokensCeMois ?? 0)} tokens`}</span></div>
              <time className="activity-time">{isLoading ? "…" : formatCost(data?.coutEstimeCeMois)}</time>
            </div>
            <div className="activity-row">
              <span className="activity-badge"><Archive /></span>
              <div className="activity-copy"><strong>Depuis toujours</strong><span>{isLoading ? "…" : `${formatStatValue(data?.tokensTotal ?? 0)} tokens cumulés`}</span></div>
              <time className="activity-time">{isLoading ? "…" : formatCost(data?.coutEstimeTotal)}</time>
            </div>
          </div>
        </section>
        <section className="panel insight-panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-heading">Répartition par modèle</h2>
              <p className="panel-kicker">Coût estimé ce mois-ci</p>
            </div>
            <Activity />
          </div>
          <div className="insight-body">
            {isLoading || !data?.coutParModeleCeMois || Object.keys(data.coutParModeleCeMois).length === 0 ? (
              <p className="insight-copy">Aucune consommation enregistrée ce mois-ci.</p>
            ) : (
              Object.entries(data.coutParModeleCeMois).map(([model, cost]) => (
                <div key={model} className="insight-number" style={{ fontSize: 20, marginBottom: 4 }}>
                  {formatCost(cost)}
                  <p className="insight-copy" style={{ margin: "2px 0 10px" }}>{model}</p>
                </div>
              ))
            )}
            <div className="insight-rule" />
          </div>
        </section>
      </div>
      <div className="content-grid mt-3">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-heading">Logs importants</h2>
              <p className="panel-kicker">Derniers soucis Groq ou Meta/WhatsApp détectés</p>
            </div>
            <ShieldAlert />
          </div>
          <div className="activity-list">
            {logsLoading ? (
              <div className="activity-row">
                <span className="activity-badge"><Radio /></span>
                <div className="activity-copy"><strong>Chargement…</strong></div>
              </div>
            ) : !logs || logs.length === 0 ? (
              <div className="activity-row">
                <span className="activity-badge"><CheckCircle2 /></span>
                <div className="activity-copy">
                  <strong>Aucun souci récent</strong>
                  <span>Groq et WhatsApp répondent normalement</span>
                </div>
              </div>
            ) : (
              logs.map((l) => (
                <div className="activity-row" key={l.id}>
                  <span className="activity-badge"><AlertTriangle /></span>
                  <div className="activity-copy">
                    <strong className="flex flex-wrap items-center gap-2">
                      <Badge className={logBadgeClass(l.source)}>{l.source}</Badge>
                      {l.message}
                    </strong>
                    {l.detail && <span>{l.detail}</span>}
                  </div>
                  <time className="activity-time">{formatRelativeTime(l.createdAt)}</time>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}