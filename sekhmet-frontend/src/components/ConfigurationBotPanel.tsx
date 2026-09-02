import { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage, type BotConfig, type EscalationTarget } from "@/lib/api";

function makeId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Certains WebViews / contextes HTTP ne proposent pas randomUUID.
  }
  return `esc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const fresh = (): EscalationTarget => ({
  id: makeId(),
  label: "Nouveau numéro",
  phone: "",
  priority: 1,
  enabled: true,
  start: "08:00",
  end: "18:00",
});

function normalizeConfig(raw: Partial<BotConfig> | null | undefined): BotConfig {
  const escalations: Partial<BotConfig["escalations"]> = raw?.escalations ?? {};
  const parcours: Partial<BotConfig["parcours"]> = raw?.parcours ?? {};
  const quickOptions: Partial<BotConfig["parcours"]["quickOptions"]> =
    parcours.quickOptions ?? {};
  const requiredBeforeOrder: Partial<BotConfig["parcours"]["requiredBeforeOrder"]> =
    parcours.requiredBeforeOrder ?? {};

  return {
    escalations: {
      timeoutMinutes: Number(escalations.timeoutMinutes) > 0 ? Number(escalations.timeoutMinutes) : 5,
      maxAttempts: Number(escalations.maxAttempts) > 0 ? Number(escalations.maxAttempts) : 1,
      numbers: Array.isArray(escalations.numbers)
        ? escalations.numbers.map((n, index) => ({
            ...fresh(),
            ...n,
            id: String(n.id || makeId()),
            priority: Number(n.priority) > 0 ? Number(n.priority) : index + 1,
            enabled: n.enabled !== false,
            start: n.start || "08:00",
            end: n.end || "18:00",
          }))
        : [],
    },
    parcours: {
      quickOptions: {
        enabled: quickOptions.enabled !== false,
        afterSimpleGreetingOnly: quickOptions.afterSimpleGreetingOnly !== false,
        afterGreetingDelaySeconds: Number(quickOptions.afterGreetingDelaySeconds) >= 0
          ? Number(quickOptions.afterGreetingDelaySeconds)
          : 2,
      },
      requiredBeforeOrder: {
        name: requiredBeforeOrder.name !== false,
        need: requiredBeforeOrder.need !== false,
      },
    },
  };
}

export function ConfigurationBotPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/configuration"],
    queryFn: () => api.get<BotConfig>("/api/configuration"),
  });
  const [cfg, setCfg] = useState<BotConfig | null>(null);

  useEffect(() => {
    if (data) setCfg(normalizeConfig(data));
  }, [data]);

  useEffect(() => {
    if (error) toast.error(errorMessage(error));
  }, [error]);

  const save = useMutation({
    mutationFn: (value: BotConfig) => api.put<BotConfig>("/api/configuration", value),
    onSuccess: (value) => {
      const normalized = normalizeConfig(value);
      setCfg(normalized);
      qc.invalidateQueries({ queryKey: ["/api/configuration"] });
      toast.success("Configuration enregistrée.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const numbers = useMemo(
    () => [...(cfg?.escalations?.numbers ?? [])].sort((a, b) => a.priority - b.priority),
    [cfg],
  );

  if (isLoading && !cfg) {
    return (
      <Card>
        <CardContent className="p-6">Chargement de la configuration…</CardContent>
      </Card>
    );
  }

  if (!cfg) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="font-medium">Configuration indisponible</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Impossible de charger les paramètres du bot pour le moment.
          </p>
        </CardContent>
      </Card>
    );
  }

  const patchNumber = (id: string, patch: Partial<EscalationTarget>) =>
    setCfg((current) =>
      current
        ? {
            ...current,
            escalations: {
              ...current.escalations,
              numbers: current.escalations.numbers.map((n) =>
                n.id === id ? { ...n, ...patch } : n,
              ),
            },
          }
        : current,
    );

  const updateEscalations = (patch: Partial<BotConfig["escalations"]>) =>
    setCfg((current) =>
      current
        ? { ...current, escalations: { ...current.escalations, ...patch } }
        : current,
    );

  const updateQuickOptions = (patch: Partial<BotConfig["parcours"]["quickOptions"]>) =>
    setCfg((current) =>
      current
        ? {
            ...current,
            parcours: {
              ...current.parcours,
              quickOptions: { ...current.parcours.quickOptions, ...patch },
            },
          }
        : current,
    );

  const updateRequired = (patch: Partial<BotConfig["parcours"]["requiredBeforeOrder"]>) =>
    setCfg((current) =>
      current
        ? {
            ...current,
            parcours: {
              ...current.parcours,
              requiredBeforeOrder: { ...current.parcours.requiredBeforeOrder, ...patch },
            },
          }
        : current,
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="panel-heading">Escalades et relais</h2>
            <p className="panel-kicker">
              Le numéro de priorité 1 est essayé en premier pendant sa plage horaire.
              Après le délai défini sans réponse, Sekhmet passe au suivant.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>Délai avant le relais (minutes)</span>
              <Input
                type="number"
                min={1}
                value={cfg.escalations.timeoutMinutes}
                onChange={(e) => updateEscalations({ timeoutMinutes: Number(e.target.value) })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>Nombre maximum de tentatives</span>
              <Input
                type="number"
                min={1}
                max={10}
                value={cfg.escalations.maxAttempts}
                onChange={(e) => updateEscalations({ maxAttempts: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="space-y-3">
            {numbers.length === 0 ? (
              <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                Aucun numéro d'escalade configuré. Ajoutez-en un pour permettre au bot
                de contacter un collaborateur.
              </div>
            ) : null}

            {numbers.map((n) => (
              <div
                key={n.id}
                className="grid min-w-0 gap-3 rounded-xl border p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_90px_110px_110px_auto] sm:items-end"
              >
                <label className="min-w-0 text-xs">
                  Nom
                  <Input
                    className="mt-1 min-w-0"
                    value={n.label}
                    onChange={(e) => patchNumber(n.id, { label: e.target.value })}
                  />
                </label>
                <label className="min-w-0 text-xs">
                  WhatsApp
                  <Input
                    className="mt-1 min-w-0"
                    value={n.phone}
                    placeholder="2376…"
                    onChange={(e) => patchNumber(n.id, { phone: e.target.value })}
                  />
                </label>
                <label className="text-xs">
                  Priorité
                  <Input
                    className="mt-1"
                    type="number"
                    min={1}
                    value={n.priority}
                    onChange={(e) => patchNumber(n.id, { priority: Number(e.target.value) })}
                  />
                </label>
                <label className="text-xs">
                  Début
                  <Input
                    className="mt-1"
                    type="time"
                    value={n.start}
                    onChange={(e) => patchNumber(n.id, { start: e.target.value })}
                  />
                </label>
                <label className="text-xs">
                  Fin
                  <Input
                    className="mt-1"
                    type="time"
                    value={n.end}
                    onChange={(e) => patchNumber(n.id, { end: e.target.value })}
                  />
                </label>
                <div className="flex items-center justify-between gap-2 sm:justify-start">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={n.enabled}
                      onCheckedChange={(v) => patchNumber(n.id, { enabled: v })}
                    />
                    <span className="text-xs text-muted-foreground">Actif</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Supprimer ${n.label}`}
                    onClick={() =>
                      setCfg((current) =>
                        current
                          ? {
                              ...current,
                              escalations: {
                                ...current.escalations,
                                numbers: current.escalations.numbers.filter((x) => x.id !== n.id),
                              },
                            }
                          : current,
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}

            <Button
              variant="outline"
              onClick={() =>
                setCfg((current) =>
                  current
                    ? {
                        ...current,
                        escalations: {
                          ...current.escalations,
                          numbers: [
                            ...current.escalations.numbers,
                            { ...fresh(), priority: current.escalations.numbers.length + 1 },
                          ],
                        },
                      }
                    : current,
                )
              }
            >
              <Plus className="size-4" />
              Ajouter un numéro
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="panel-heading">Parcours conversationnel</h2>
            <p className="panel-kicker">
              Ces paramètres contrôlent quand l'assistant propose des raccourcis et
              quelles informations sont nécessaires avant une commande.
            </p>
          </div>

          <div className="space-y-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">Afficher les options rapides</p>
                <p className="text-sm text-muted-foreground">
                  Catalogue, commande et conseiller.
                </p>
              </div>
              <Switch
                checked={cfg.parcours.quickOptions.enabled}
                onCheckedChange={(v) => updateQuickOptions({ enabled: v })}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">Uniquement après une salutation simple</p>
                <p className="text-sm text-muted-foreground">
                  Évite d'afficher les raccourcis sur une demande déjà précise.
                </p>
              </div>
              <Switch
                checked={cfg.parcours.quickOptions.afterSimpleGreetingOnly}
                onCheckedChange={(v) => updateQuickOptions({ afterSimpleGreetingOnly: v })}
              />
            </div>

            <label className="block text-sm">
              Délai d'affichage après la salutation (secondes)
              <Input
                className="mt-1"
                type="number"
                min={0}
                value={cfg.parcours.quickOptions.afterGreetingDelaySeconds}
                onChange={(e) =>
                  updateQuickOptions({ afterGreetingDelaySeconds: Number(e.target.value) })
                }
              />
            </label>
          </div>

          <div className="space-y-3 rounded-xl border p-4">
            <p className="font-medium">Informations obligatoires avant de commencer une commande</p>
            <div className="flex items-center justify-between">
              <span>Nom du client</span>
              <Switch
                checked={cfg.parcours.requiredBeforeOrder.name}
                onCheckedChange={(v) => updateRequired({ name: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span>Besoin du client</span>
              <Switch
                checked={cfg.parcours.requiredBeforeOrder.need}
                onCheckedChange={(v) => updateRequired({ need: v })}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate(cfg)} disabled={save.isPending}>
              <Save className="size-4" />
              {save.isPending ? "Enregistrement…" : "Enregistrer la configuration"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
