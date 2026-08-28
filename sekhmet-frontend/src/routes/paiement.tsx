import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

type PaiementCompte = { numero: string; nom: string };

export const Route = createFileRoute("/paiement")({
  head: () => ({
    meta: [
      { title: "Compte de paiement — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Configurez le numéro et le nom du compte dans lequel les clients paient.",
      },
      { property: "og:title", content: "Compte de paiement — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Configurez le numéro et le nom du compte dans lequel les clients paient.",
      },
    ],
  }),
  component: PaiementPage,
});

const ENDPOINT = "/api/paiement-compte";

function PaiementPage() {
  const queryClient = useQueryClient();
  const [numero, setNumero] = useState("");
  const [nom, setNom] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: [ENDPOINT],
    queryFn: () => api.get<PaiementCompte>(ENDPOINT),
  });

  useEffect(() => {
    if (data) {
      setNumero(data.numero ?? "");
      setNom(data.nom ?? "");
    }
  }, [data]);

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const save = useMutation({
    mutationFn: () => api.put<PaiementCompte>(ENDPOINT, { numero, nom }),
    onSuccess: () => {
      toast.success("Compte de paiement enregistré.");
      queryClient.invalidateQueries({ queryKey: [ENDPOINT] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title="Compte de paiement"
        description="Numéro et nom communiqués automatiquement par l'agent quand un client veut payer."
      />

      <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/50 bg-accent/10 px-4 py-3 text-sm text-foreground/80">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
        <p>
          Dès qu'un client demande comment payer, l'agent lui transmet automatiquement ce numéro (et
          ce nom, s'il est renseigné) — vérifiez bien ces informations avant d'enregistrer.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : (
        <div className="space-y-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="compte-numero">
              Numéro du compte (Mobile Money, Orange Money, MTN MoMo...)
            </Label>
            <Input
              id="compte-numero"
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              placeholder="Ex : 6XX XX XX XX"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="compte-nom">Nom qui apparaît sur le compte</Label>
            <Input
              id="compte-nom"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              placeholder="Ex : Sekhmet Shop"
            />
            <p className="text-xs text-muted-foreground">
              Optionnel, mais recommandé : le client peut ainsi vérifier le nom avant d'envoyer son
              paiement.
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading || !numero.trim()}
          className="w-full md:w-auto"
        >
          {save.isPending ? "Enregistrement..." : "Enregistrer"}
        </Button>
      </div>
    </div>
  );
}
