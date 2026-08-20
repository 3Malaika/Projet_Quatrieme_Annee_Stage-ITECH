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
} from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type Stats } from "@/lib/api";

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
] as const;

function Dashboard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/stats"],
    queryFn: () => api.get<Stats>("/api/stats"),
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

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
                  <p className="stat-value">{data?.[key] ?? "—"}</p>
                )}
              <p className="stat-note">{key === "produitsEnRupture" ? "Aucun réassort à prévoir" : key === "escaladesEnAttente" ? "File de suivi claire" : "Références actives"}</p>
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
    </div>
  );
}