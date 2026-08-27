import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, fetchFacturePdfBlob, type Commande } from "@/lib/api";

export const Route = createFileRoute("/factures")({
  head: () => ({
    meta: [
      { title: "Factures — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Consultez et téléchargez les factures générées après chaque paiement client.",
      },
      { property: "og:title", content: "Factures — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Historique des commandes payées et de leurs factures PDF.",
      },
    ],
  }),
  component: FacturesPage,
});

function formatDate(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

function formatMontant(montant: number) {
  return `${Number(montant).toLocaleString("fr-FR")} FCFA`;
}

function FacturesPage() {
  const [downloadingId, setDownloadingId] = useState<string | number | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/commandes"],
    queryFn: () => api.get<Commande[]>("/api/commandes"),
    refetchInterval: 30_000,
  });

  const telecharger = async (commande: Commande) => {
    setDownloadingId(commande.id);
    try {
      const blob = await fetchFacturePdfBlob(commande.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const list = [...(data ?? [])].sort(
    (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
  );

  if (isError) toast.error(errorMessage(error));

  return (
    <div>
      <PageHeader title="Factures" description="Commandes payées et factures générées automatiquement." />

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aucune facture pour le moment.
        </p>
      ) : (
        <div className="space-y-4">
          {list.map((commande) => {
            const facturee = commande.statut === "facturee";
            return (
              <Card key={commande.id} className="rounded-xl border-border/70 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-primary">
                        {commande.nom_client || commande.phone}
                      </p>
                      <p className="text-xs text-muted-foreground">{commande.phone}</p>
                    </div>
                    <Badge
                      className={
                        facturee
                          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100"
                          : "bg-amber-100 text-amber-700 hover:bg-amber-100"
                      }
                    >
                      {facturee ? "Facturée" : "Paiement confirmé"}
                    </Badge>
                  </div>

                  <p className="mt-3 text-sm text-foreground">{commande.produits}</p>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div className="space-y-0.5">
                      <p className="font-semibold">{formatMontant(commande.montant_total)}</p>
                      {commande.delai_livraison ? (
                        <p className="text-xs text-muted-foreground">
                          Livraison : {commande.delai_livraison}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">{formatDate(commande.created_at)}</p>
                    </div>

                    {commande.numero_facture ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={downloadingId === commande.id}
                        onClick={() => telecharger(commande)}
                      >
                        <Download className="h-4 w-4" />
                        {commande.numero_facture}
                      </Button>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <FileText className="h-3.5 w-3.5" />
                        En attente du délai de livraison
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
