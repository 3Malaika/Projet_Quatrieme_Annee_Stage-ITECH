import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Archive,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Coins,
  DollarSign,
  Filter,
  Layers3,
  MessagesSquare,
  Package,
  PackageX,
  Radio,
  ShieldAlert,
  ShoppingCart,
  TrendingUp,
  UserCheck,
  Users,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { api, errorMessage, type AchatStats, type LogImportant, type Stats } from "@/lib/api";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tableau de bord — Sekhmet Shop Admin" },
      { name: "description", content: "Vue d'ensemble de la boutique Sekhmet Shop : produits, ventes, escalades et conversations WhatsApp." },
      { property: "og:title", content: "Tableau de bord — Sekhmet Shop Admin" },
      { property: "og:description", content: "Statistiques en temps réel de l'agent WhatsApp Sekhmet Shop." },
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
  { key: "appelsAujourdHui", label: "Utilisations de l’IA aujourd’hui", icon: Zap },
  { key: "tokensAujourdHui", label: "Consommation IA aujourd’hui", icon: Coins },
] as const;

function formatStatValue(value: number) {
  return value.toLocaleString("fr-FR");
}

function formatCost(value: number | undefined) {
  if (value === undefined) return "—";
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`;
}

function formatMoney(value: number) {
  return `${Math.round(value).toLocaleString("fr-FR")} F`;
}

function formatRelativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function logBadgeClass(source: string) {
  if (source === "Assistant IA") return "bg-accent text-accent-foreground";
  if (source === "WhatsApp") return "bg-destructive text-destructive-foreground";
  return "bg-secondary text-secondary-foreground";
}

function localDate(daysAgo = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function Dashboard() {
  const [from, setFrom] = useState(() => localDate(29));
  const [to, setTo] = useState(() => localDate(0));
  const [product, setProduct] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("paiement_confirme,facturee");
  const [hourFrom, setHourFrom] = useState("");
  const [hourTo, setHourTo] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/stats"],
    queryFn: () => api.get<Stats>("/api/stats"),
  });

  const { data: achats, isLoading: achatsLoading, isError: achatsIsError, error: achatsError } = useQuery({
    queryKey: ["/api/stats/achats", from, to, product, category, status, hourFrom, hourTo],
    queryFn: () => {
      const params = new URLSearchParams({ from, to });
      if (product) params.set("product", product);
      if (category) params.set("category", category);
      if (status) params.set("status", status);
      if (hourFrom) params.set("hourFrom", hourFrom);
      if (hourTo) params.set("hourTo", hourTo);
      return api.get<AchatStats>(`/api/stats/achats?${params.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const { data: logs, isLoading: logsLoading, isError: logsIsError, error: logsError } = useQuery({
    queryKey: ["/api/logs"],
    queryFn: () => api.get<LogImportant[]>("/api/logs?limit=6"),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);
  useEffect(() => {
    if (achatsIsError) toast.error(errorMessage(achatsError));
  }, [achatsIsError, achatsError]);
  useEffect(() => {
    if (logsIsError) toast.error(errorMessage(logsError));
  }, [logsIsError, logsError]);

  const productOptions = achats?.options.products ?? [];
  const categoryOptions = achats?.options.categories ?? [];

  const resetFilters = () => {
    setFrom(localDate(29));
    setTo(localDate(0));
    setProduct("");
    setCategory("");
    setStatus("paiement_confirme,facturee");
    setHourFrom("");
    setHourTo("");
  };

  const filterLabel = useMemo(() => {
    const active = [product, category, hourFrom || hourTo, status !== "paiement_confirme,facturee"].filter(Boolean).length;
    return `${active} filtre${active > 1 ? "s" : ""} avancé${active > 1 ? "s" : ""}`;
  }, [product, category, hourFrom, hourTo, status]);

  return (
    <div>
      <PageHeader title="Tableau de bord" description="Un aperçu calme et précis de ce qui se passe dans votre boutique aujourd’hui." />

      <div className="stats-grid">
        {CARDS.map(({ key, label, icon: Icon }) => (
          <Card key={key} className="stat-card">
            <CardContent className="p-0">
              <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon"><Icon /></span></div>
              {isLoading ? <Skeleton className="mt-4 h-8 w-16" /> : <p className="stat-value">{data?.[key] !== undefined ? formatStatValue(data[key]) : "—"}</p>}
              <p className="stat-note">{key === "produitsEnRupture" ? "Aucun réassort à prévoir" : key === "escaladesEnAttente" ? "Demandes à traiter" : key === "tokensAujourdHui" ? (data?.suiviDisponible === false ? "Suivi à configurer" : "Unités de texte utilisées") : key === "appelsAujourdHui" ? "Réponses générées par l’assistant" : "Références actives"}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="sales-analytics mt-3">
        <div className="panel analytics-panel">
          <div className="panel-header analytics-header">
            <div>
              <div className="analytics-title-row"><BarChart3 /><h2 className="panel-heading">Analyse des achats</h2></div>
              <p className="panel-kicker">CA, commandes, quantités et comportements d’achat. Les filtres s’appliquent à tous les graphiques.</p>
            </div>
            <span className="analytics-filter-count"><Filter />{filterLabel}</span>
          </div>

          <div className="analytics-filters">
            <label><span>Du</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
            <label><span>Au</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="analytics-filter-wide"><span>Produit</span><select value={product} onChange={(e) => setProduct(e.target.value)}><option value="">Tous les produits</option>{productOptions.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}</select></label>
            <label><span>Catégorie</span><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Toutes</option>{categoryOptions.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select></label>
            <label><span>Statut</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="paiement_confirme,facturee">Payées / facturées</option><option value="paiement_confirme">Paiement confirmé</option><option value="facturee">Facturées</option></select></label>
            <label><span>Heure min.</span><select value={hourFrom} onChange={(e) => setHourFrom(e.target.value)}><option value="">Toutes</option>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>)}</select></label>
            <label><span>Heure max.</span><select value={hourTo} onChange={(e) => setHourTo(e.target.value)}><option value="">Toutes</option>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>)}</select></label>
            <button type="button" className="analytics-reset" onClick={resetFilters}>Réinitialiser</button>
          </div>
        </div>

        <div className="analytics-kpi-grid">
          <AnalyticsKpi icon={DollarSign} label="Chiffre d’affaires" value={achatsLoading ? "…" : formatMoney(achats?.kpis.revenue ?? 0)} note={`${from} → ${to}`} />
          <AnalyticsKpi icon={ShoppingCart} label="Commandes" value={achatsLoading ? "…" : formatStatValue(achats?.kpis.orders ?? 0)} note="commandes payées" />
          <AnalyticsKpi icon={Package} label="Unités vendues" value={achatsLoading ? "…" : formatStatValue(achats?.kpis.units ?? 0)} note="quantités détaillées" />
          <AnalyticsKpi icon={TrendingUp} label="Panier moyen" value={achatsLoading ? "…" : formatMoney(achats?.kpis.averageOrderValue ?? 0)} note="CA / commande" />
          <AnalyticsKpi icon={Users} label="Clients uniques" value={achatsLoading ? "…" : formatStatValue(achats?.kpis.uniqueCustomers ?? 0)} note="numéros distincts" />
        </div>

        {achats?.kpis.undetailedOrders ? (
          <div className="analytics-notice"><AlertTriangle /> {achats.kpis.undetailedOrders} commande{achats.kpis.undetailedOrders > 1 ? "s" : ""} sans détail produit : elles restent incluses dans le CA et les commandes, mais pas dans les classements produit.</div>
        ) : null}

        <div className="analytics-chart-grid">
          <ChartPanel title="Ventes par jour" subtitle="CA quotidien sur la période" icon={CalendarDays} wide>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={achats?.daily ?? []} margin={{ top: 8, right: 18, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" minTickGap={24} />
                <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v: number) => [formatMoney(v), "CA"]} />
                <Line type="monotone" dataKey="revenue" name="CA" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Ventes par mois" subtitle="Évolution mensuelle du CA" icon={TrendingUp}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={achats?.monthly ?? []} margin={{ top: 8, right: 18, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v: number) => [formatMoney(v), "CA"]} />
                <Bar dataKey="revenue" name="CA" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Top produits" subtitle="Les références qui génèrent le plus de CA" icon={Package} wide>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart layout="vertical" data={(achats?.byProduct ?? []).slice(0, 12)} margin={{ top: 8, right: 25, left: 10, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <YAxis type="category" dataKey="label" width={180} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => [formatMoney(v), "CA"]} />
                <Bar dataKey="revenue" name="CA" radius={[0, 5, 5, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="CA par catégorie" subtitle="Répartition du chiffre d’affaires" icon={Layers3}>
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie data={achats?.byCategory ?? []} dataKey="revenue" nameKey="label" cx="50%" cy="50%" outerRadius={100} innerRadius={52} paddingAngle={2}>
                  {(achats?.byCategory ?? []).map((entry, index) => <Cell key={`${entry.key}-${index}`} />)}
                </Pie>
                <Tooltip formatter={(v: number) => [formatMoney(v), "CA"]} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Moments de la journée" subtitle="Quand les commandes arrivent" icon={Clock3}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={achats?.byDayPart ?? []} margin={{ top: 8, right: 18, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v: number) => [v, "Commandes"]} />
                <Bar dataKey="orders" name="Commandes" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Heures de pointe" subtitle="Volume de commandes par heure locale" icon={Clock3}>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={achats?.byHour ?? []} margin={{ top: 8, right: 18, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="hour" tickFormatter={(v) => `${v}h`} />
                <YAxis allowDecimals={false} />
                <Tooltip labelFormatter={(v) => `${v}h`} formatter={(v: number) => [v, "Commandes"]} />
                <Line type="monotone" dataKey="orders" name="Commandes" strokeWidth={2.5} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Jours les plus actifs" subtitle="Pour comparer les habitudes de la semaine" icon={CalendarDays} wide>
            <ResponsiveContainer width="100%" height={290}>
              <BarChart data={achats?.byWeekday ?? []} margin={{ top: 8, right: 18, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="weekday" tickFormatter={(v) => String(v).slice(0, 3)} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v: number) => [v, "Commandes"]} />
                <Bar dataKey="orders" name="Commandes" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        </div>
      </section>

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
          <div className="insight-body"><div className="insight-number">{achats?.kpis.orders ?? "—"}</div><p className="insight-copy">commandes dans la période sélectionnée, pour {formatMoney(achats?.kpis.revenue ?? 0)} de chiffre d’affaires.</p><div className="insight-rule" /></div>
        </section>
      </div>

      <div className="content-grid mt-3">
        <section className="panel">
          <div className="panel-header">
            <div><h2 className="panel-heading">Utilisation de l’IA</h2><p className="panel-kicker">Suivi de la consommation du service qui répond aux clients</p></div><DollarSign />
          </div>
          {!isLoading && data?.suiviDisponible === false ? (
            <div className="activity-row">
              <span className="activity-badge"><AlertTriangle /></span>
              <div className="activity-copy"><strong>Suivi de consommation indisponible</strong><span>La connexion au suivi IA doit être configurée dans Supabase. Aucune consommation n’est inventée.</span></div>
            </div>
          ) : (
            <div className="activity-list">
              <div className="activity-row"><span className="activity-badge"><Zap /></span><div className="activity-copy"><strong>Aujourd’hui</strong><span>{isLoading ? "…" : `${formatStatValue(data?.appelsAujourdHui ?? 0)} utilisations · ${formatStatValue(data?.tokensAujourdHui ?? 0)} tokens`}</span></div><time className="activity-time">{isLoading ? "…" : formatCost(data?.coutEstimeAujourdHui)}</time></div>
              <div className="activity-row"><span className="activity-badge"><Coins /></span><div className="activity-copy"><strong>Ce mois-ci</strong><span>{isLoading ? "…" : `${formatStatValue(data?.appelsCeMois ?? 0)} utilisations · ${formatStatValue(data?.tokensCeMois ?? 0)} tokens`}</span></div><time className="activity-time">{isLoading ? "…" : formatCost(data?.coutEstimeCeMois)}</time></div>
              <div className="activity-row"><span className="activity-badge"><Archive /></span><div className="activity-copy"><strong>Depuis le début du suivi</strong><span>{isLoading ? "…" : `${formatStatValue(data?.tokensTotal ?? 0)} tokens utilisés`}</span></div><time className="activity-time">{isLoading ? "…" : formatCost(data?.coutEstimeTotal)}</time></div>
            </div>
          )}
        </section>
        <section className="panel insight-panel">
          <div className="panel-header"><div><h2 className="panel-heading">À savoir</h2><p className="panel-kicker">Comprendre le compteur</p></div><Activity /></div>
          <div className="insight-body"><div className="insight-number">IA</div><p className="insight-copy">Un token correspond à une petite unité de texte traitée par l’assistant. Le montant affiché est une estimation de la consommation, pas une facture.</p><div className="insight-rule" /></div>
        </section>
      </div>
      <div className="content-grid mt-3">
        <section className="panel">
          <div className="panel-header"><div><h2 className="panel-heading">Alertes importantes</h2><p className="panel-kicker">Uniquement les problèmes qui peuvent perturber les échanges avec les clients</p></div><ShieldAlert /></div>
          <div className="activity-list">
            {logsLoading ? <div className="activity-row"><span className="activity-badge"><Radio /></span><div className="activity-copy"><strong>Chargement…</strong></div></div> : !logs || logs.length === 0 ? <div className="activity-row"><span className="activity-badge"><CheckCircle2 /></span><div className="activity-copy"><strong>Tout fonctionne normalement</strong><span>Aucun problème important détecté avec l’assistant ou WhatsApp</span></div></div> : logs.map((l) => <div className="activity-row" key={l.id}><span className="activity-badge"><AlertTriangle /></span><div className="activity-copy"><strong className="flex flex-wrap items-center gap-2"><Badge className={logBadgeClass(l.source)}>{l.source}</Badge>{l.message}</strong>{l.detail && <span>{l.detail}</span>}</div><time className="activity-time">{formatRelativeTime(l.createdAt)}</time></div>)}
          </div>
        </section>
      </div>
    </div>
  );
}

function AnalyticsKpi({ icon: Icon, label, value, note }: { icon: typeof DollarSign; label: string; value: string; note: string }) {
  return <div className="analytics-kpi"><span className="analytics-kpi-icon"><Icon /></span><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></div>;
}

function ChartPanel({ title, subtitle, icon: Icon, wide = false, children }: { title: string; subtitle: string; icon: typeof CalendarDays; wide?: boolean; children: React.ReactNode }) {
  return <section className={`analytics-chart panel ${wide ? "analytics-chart-wide" : ""}`}><div className="analytics-chart-header"><div className="analytics-chart-title"><span className="analytics-chart-icon"><Icon /></span><div><h3>{title}</h3><p>{subtitle}</p></div></div></div><div className="analytics-chart-body">{children}</div></section>;
}
