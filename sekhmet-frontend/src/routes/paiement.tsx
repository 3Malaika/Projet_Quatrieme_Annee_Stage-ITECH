import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Info, Plus, Trash2 } from "lucide-react";
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
      { title: "Comptes de paiement — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Configurez les numéros et noms des comptes dans lesquels les clients paient.",
      },
      { property: "og:title", content: "Comptes de paiement — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Configurez les numéros et noms des comptes dans lesquels les clients paient.",
      },
    ],
  }),
  component: PaiementPage,
});

const ENDPOINT = "/api/paiement-compte";
const EMPTY_COMPTE: PaiementCompte = { numero: "", nom: "" };

function PaiementPage() {
  const queryClient = useQueryClient();
  const [comptes, setComptes] = useState<PaiementCompte[]>([{ ...EMPTY_COMPTE }]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: [ENDPOINT],
    queryFn: () => api.get<PaiementCompte[]>(ENDPOINT),
  });

  useEffect(() => {
    if (data) {
      setComptes(data.length > 0 ? data : [{ ...EMPTY_COMPTE }]);
    }
  }, [data]);

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const save = useMutation({
    mutationFn: () =>
      api.put<PaiementCompte[]>(ENDPOINT, {
        comptes: comptes
          .map((c) => ({ numero: c.numero.trim(), nom: c.nom.trim() }))
          .filter((c) => c.numero),
      }),
    onSuccess: () => {
      toast.success("Comptes de paiement enregistrés.");
      queryClient.invalidateQueries({ queryKey: [ENDPOINT] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const updateCompte = (index: number, patch: Partial<PaiementCompte>) => {
    setComptes((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addCompte = () => {
    setComptes((prev) => [...prev, { ...EMPTY_COMPTE }]);
  };

  const removeCompte = (index: number) => {
    setComptes((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ ...EMPTY_COMPTE }];
    });
  };

  const hasAtLeastOneNumero = comptes.some((c) => c.numero.trim());

  return (
    <div>
      <PageHeader
        title="Comptes de paiement"
        description="Numéros et noms communiqués automatiquement par l'agent quand un client veut payer."
      />

      <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/50 bg-accent/10 px-4 py-3 text-sm text-foreground/80">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
        <p>
          Dès qu'un client demande comment payer, l'agent lui transmet automatiquement ce(s)
          numéro(s) (et le nom associé, s'il est renseigné) — vérifiez bien ces informations avant
          d'enregistrer. Vous pouvez ajouter plusieurs numéros (ex : un par opérateur Mobile Money).
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : (
        <div className="space-y-4">
          {comptes.map((compte, index) => (
            <div
              key={index}
              className="relative space-y-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm"
            >
              {comptes.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeCompte(index)}
                  aria-label="Supprimer ce numéro"
                  className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
              <div className="space-y-2">
                <Label htmlFor={`compte-numero-${index}`}>
                  Numéro du compte {comptes.length > 1 ? `#${index + 1}` : ""} (Mobile Money,
                  Orange Money, MTN MoMo...)
                </Label>
                <Input
                  id={`compte-numero-${index}`}
                  value={compte.numero}
                  onChange={(e) => updateCompte(index, { numero: e.target.value })}
                  placeholder="Ex : 6XX XX XX XX"
                  className="pr-8"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`compte-nom-${index}`}>Nom qui apparaît sur le compte</Label>
                <Input
                  id={`compte-nom-${index}`}
                  value={compte.nom}
                  onChange={(e) => updateCompte(index, { nom: e.target.value })}
                  placeholder="Ex : Sekhmet Shop"
                />
                <p className="text-xs text-muted-foreground">
                  Optionnel, mais recommandé : le client peut ainsi vérifier le nom avant d'envoyer
                  son paiement.
                </p>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            onClick={addCompte}
            className="w-full gap-2 border-dashed"
          >
            <Plus className="size-4" />
            Ajouter un numéro
          </Button>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading || !hasAtLeastOneNumero}
          className="w-full md:w-auto"
        >
          {save.isPending ? "Enregistrement..." : "Enregistrer"}
        </Button>
      </div>
    </div>
  );
}
