import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Package,
  PackageX,
  AlertTriangle,
  CheckCircle2,
  MessagesSquare,
  UserCheck,
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
      <PageHeader title="Tableau de bord" description="Activité de la boutique en un coup d'œil." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(({ key, label, icon: Icon }) => (
          <Card key={key} className="rounded-xl border-border/70 shadow-sm">
            <CardContent className="flex items-center gap-4 p-5">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Icon className="size-6 text-primary" />
              </span>
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">{label}</p>
                {isLoading ? (
                  <Skeleton className="mt-1 h-8 w-16" />
                ) : (
                  <p className="text-2xl font-bold text-primary">{data?.[key] ?? "—"}</p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}