import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage, type BotConfig, type EscalationTarget } from "@/lib/api";

const fresh = (): EscalationTarget => ({ id: crypto.randomUUID(), label: "Nouveau numéro", phone: "", priority: 1, enabled: true, start: "08:00", end: "18:00" });

export function ConfigurationBotPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["/api/configuration"], queryFn: () => api.get<BotConfig>("/api/configuration") });
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  useEffect(() => { if (data) setCfg(data); }, [data]);
  useEffect(() => { if (error) toast.error(errorMessage(error)); }, [error]);

  const save = useMutation({
    mutationFn: (value: BotConfig) => api.put<BotConfig>("/api/configuration", value),
    onSuccess: (value) => { setCfg(value); qc.invalidateQueries({ queryKey: ["/api/configuration"] }); toast.success("Configuration enregistrée."); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading || !cfg) return <Card><CardContent className="p-6">Chargement de la configuration…</CardContent></Card>;
  const numbers = [...cfg.escalations.numbers].sort((a,b) => a.priority-b.priority);
  const patchNumber = (id: string, patch: Partial<EscalationTarget>) => setCfg({ ...cfg, escalations: { ...cfg.escalations, numbers: cfg.escalations.numbers.map(n => n.id === id ? { ...n, ...patch } : n) } });
  return (
    <div className="space-y-4">
      <Card><CardContent className="p-6 space-y-5">
        <div><h2 className="panel-heading">Escalades et relais</h2><p className="panel-kicker">Le numéro de priorité 1 est essayé en premier pendant sa plage horaire. Après le délai défini sans réponse, Sekhmet passe au suivant.</p></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span>Délai avant le relais (minutes)</span><Input type="number" min={1} value={cfg.escalations.timeoutMinutes} onChange={e=>setCfg({...cfg, escalations:{...cfg.escalations,timeoutMinutes:Number(e.target.value)}})} /></label>
          <label className="space-y-1 text-sm"><span>Nombre maximum de tentatives</span><Input type="number" min={1} max={10} value={cfg.escalations.maxAttempts} onChange={e=>setCfg({...cfg, escalations:{...cfg.escalations,maxAttempts:Number(e.target.value)}})} /></label>
        </div>
        <div className="space-y-3">
          {numbers.map(n=><div key={n.id} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[1.2fr_1.3fr_90px_110px_110px_auto] sm:items-end">
            <label className="text-xs">Nom<Input value={n.label} onChange={e=>patchNumber(n.id,{label:e.target.value})}/></label>
            <label className="text-xs">WhatsApp<Input value={n.phone} placeholder="2376…" onChange={e=>patchNumber(n.id,{phone:e.target.value})}/></label>
            <label className="text-xs">Priorité<Input type="number" min={1} value={n.priority} onChange={e=>patchNumber(n.id,{priority:Number(e.target.value)})}/></label>
            <label className="text-xs">Début<Input type="time" value={n.start} onChange={e=>patchNumber(n.id,{start:e.target.value})}/></label>
            <label className="text-xs">Fin<Input type="time" value={n.end} onChange={e=>patchNumber(n.id,{end:e.target.value})}/></label>
            <div className="flex items-center gap-2"><Switch checked={n.enabled} onCheckedChange={v=>patchNumber(n.id,{enabled:v})}/><Button type="button" variant="ghost" size="icon" onClick={()=>setCfg({...cfg,escalations:{...cfg.escalations,numbers:cfg.escalations.numbers.filter(x=>x.id!==n.id)}})}><Trash2 className="size-4"/></Button></div>
          </div>)}
          <Button variant="outline" onClick={()=>setCfg({...cfg,escalations:{...cfg.escalations,numbers:[...cfg.escalations.numbers,{...fresh(),priority:cfg.escalations.numbers.length+1}]}})}><Plus className="size-4"/> Ajouter un numéro</Button>
        </div>
      </CardContent></Card>

      <Card><CardContent className="p-6 space-y-5">
        <div><h2 className="panel-heading">Parcours conversationnel</h2><p className="panel-kicker">Ces paramètres contrôlent quand l'assistant propose des raccourcis et quelles informations sont nécessaires avant une commande.</p></div>
        <div className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center justify-between gap-4"><div><p className="font-medium">Afficher les options rapides</p><p className="text-sm text-muted-foreground">Catalogue, commande et conseiller.</p></div><Switch checked={cfg.parcours.quickOptions.enabled} onCheckedChange={v=>setCfg({...cfg,parcours:{...cfg.parcours,quickOptions:{...cfg.parcours.quickOptions,enabled:v}}})}/></div>
          <div className="flex items-center justify-between gap-4"><div><p className="font-medium">Uniquement après une salutation simple</p><p className="text-sm text-muted-foreground">Évite d'afficher les raccourcis sur une demande déjà précise.</p></div><Switch checked={cfg.parcours.quickOptions.afterSimpleGreetingOnly} onCheckedChange={v=>setCfg({...cfg,parcours:{...cfg.parcours,quickOptions:{...cfg.parcours.quickOptions,afterSimpleGreetingOnly:v}}})}/></div>
          <label className="block text-sm">Délai d'affichage après la salutation (secondes)<Input type="number" min={0} value={cfg.parcours.quickOptions.afterGreetingDelaySeconds} onChange={e=>setCfg({...cfg,parcours:{...cfg.parcours,quickOptions:{...cfg.parcours.quickOptions,afterGreetingDelaySeconds:Number(e.target.value)}}})}/></label>
        </div>
        <div className="space-y-3 rounded-xl border p-4">
          <p className="font-medium">Informations obligatoires avant de commencer une commande</p>
          <div className="flex items-center justify-between"><span>Nom du client</span><Switch checked={cfg.parcours.requiredBeforeOrder.name} onCheckedChange={v=>setCfg({...cfg,parcours:{...cfg.parcours,requiredBeforeOrder:{...cfg.parcours.requiredBeforeOrder,name:v}}})}/></div>
          <div className="flex items-center justify-between"><span>Besoin du client</span><Switch checked={cfg.parcours.requiredBeforeOrder.need} onCheckedChange={v=>setCfg({...cfg,parcours:{...cfg.parcours,requiredBeforeOrder:{...cfg.parcours.requiredBeforeOrder,need:v}}})}/></div>
        </div>
        <div className="flex justify-end"><Button onClick={()=>save.mutate(cfg)} disabled={save.isPending}><Save className="size-4"/>{save.isPending?"Enregistrement…":"Enregistrer la configuration"}</Button></div>
      </CardContent></Card>
    </div>
  );
}
