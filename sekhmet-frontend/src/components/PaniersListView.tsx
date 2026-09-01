import { useQuery } from "@tanstack/react-query";
import { RefreshCw, ShoppingCart } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type PanierActif } from "@/lib/api";

function formatMoney(value: number) {
  return `${Number(value).toLocaleString("fr-FR")} FCFA`;
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export function PaniersListView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["/api/paniers"],
    queryFn: () => api.get<PanierActif[]>("/api/paniers"),
    refetchInterval: 15_000,
  });

  if (isError) toast.error(errorMessage(error));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Paniers"
          description="Paniers en cours constitués par les clients avant validation de la commande."
        />
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="size-4" />
          Actualiser
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
        </div>
      ) : !data?.length ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <ShoppingCart className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="font-medium">Aucun panier en cours</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Les paniers apparaissent ici dès qu'un client sélectionne au moins un produit.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((panier) => (
            <Card key={panier.phone} className="rounded-xl border-border/70 shadow-sm">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-all font-semibold text-primary">{panier.phone}</p>
                    <p className="text-xs text-muted-foreground">
                      Dernière sélection : {formatDate(panier.updatedAt)}
                    </p>
                  </div>
                  <div className="flex max-w-full flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {panier.count} article{panier.count > 1 ? "s" : ""}
                    </Badge>
                    <span className="font-semibold">{formatMoney(panier.total)}</span>
                  </div>
                </div>
                <div className="mt-4 divide-y rounded-lg border">
                  {panier.items.map((item, index) => (
                    <div
                      key={`${item.produitId ?? item.nom}-${index}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                    >
                      <span className="min-w-0 break-words">
                        {item.quantite} × {item.nom}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{formatMoney(item.total)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
