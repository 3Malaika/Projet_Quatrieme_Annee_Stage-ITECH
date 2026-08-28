import { Router } from "express";
import { config } from "../config/env.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getEscalationsLog } from "../services/escalation.service.js";
import { getAllConversations } from "../services/chat.service.js";
import { getUsageSummary } from "../services/usage.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("stats");

const { loadCatalogue } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const { loadClients } = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const { loadCommandes } = config.supabaseUrl
  ? await import("../data/commandes.store.supabase.js")
  : await import("../data/commandes.store.js");

const router = Router();

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s/g, "").replace(/[^0-9,.-]/g, "").replace(",", ".");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : fallback;
}

function parseDetails(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Les timestamps de commandes sont stockés en timestamptz. Le dashboard
// travaille en heure locale de la boutique (Yaoundé), sans dépendre du fuseau
// horaire de la machine qui exécute Node.
const SHOP_TIME_ZONE = "Africa/Douala";
const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
  timeZone: SHOP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "long",
});

function localParts(iso) {
  const parts = Object.fromEntries(timeFormatter.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: parts.weekday,
  };
}

function localDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function monthKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function displayDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function displayMonth(key) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function startOfTodayLocalUtc() {
  const now = new Date();
  const parts = localParts(now.toISOString());
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - 60 * 60 * 1000);
}

function endOfTodayLocalUtc() {
  return new Date(startOfTodayLocalUtc().getTime() + 24 * 60 * 60 * 1000);
}

function localDateToUtc(dateString, end = false) {
  // Africa/Douala est UTC+1. On garde cette conversion explicite pour que
  // les filtres journaliers soient identiques en local et sur Supabase.
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0) - 60 * 60 * 1000);
}

function enumerateDays(start, end) {
  const result = [];
  for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    result.push(cursor.toISOString().slice(0, 10));
  }
  return result;
}

function enumerateMonths(start, end) {
  const result = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor < end) {
    result.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

const WEEKDAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const DAYPARTS = [
  { key: "nuit", label: "Nuit", min: 0, max: 6 },
  { key: "matin", label: "Matin", min: 6, max: 12 },
  { key: "apres_midi", label: "Après-midi", min: 12, max: 18 },
  { key: "soir", label: "Soir", min: 18, max: 24 },
];

function getDayPart(hour) {
  return DAYPARTS.find((part) => hour >= part.min && hour < part.max) || DAYPARTS[0];
}

function normalizeStatus(status) {
  if (!status) return ["paiement_confirme", "facturee"];
  return String(status).split(",").map((value) => value.trim()).filter(Boolean);
}

router.get("/", requireAdmin, async (req, res) => {
  try {
    const [catalogue, escalades, conversations, clients, usage] = await Promise.all([
      loadCatalogue(),
      getEscalationsLog(),
      getAllConversations(),
      loadClients(),
      getUsageSummary(),
    ]);

    res.json({
      totalProduits: catalogue.length,
      produitsEnRupture: catalogue.filter((p) => p.stock === "rupture").length,
      escaladesEnAttente: escalades.filter((e) => e.status === "en_attente").length,
      escaladesCloturees: escalades.filter((e) => e.status === "cloturee").length,
      conversationsActives: conversations.length,
      clientsIdentifies: Object.keys(clients).length,
      appelsAujourdHui: usage.appelsAujourdHui,
      tokensAujourdHui: usage.tokensAujourdHui,
      appelsCeMois: usage.appelsCeMois,
      tokensCeMois: usage.tokensCeMois,
      tokensTotal: usage.tokensTotal,
      coutEstimeAujourdHui: usage.coutEstimeAujourdHui,
      coutEstimeCeMois: usage.coutEstimeCeMois,
      coutEstimeTotal: usage.coutEstimeTotal,
      coutParModeleCeMois: usage.coutParModeleCeMois,
    });
  } catch (err) {
    log.error("Échec du calcul des stats admin", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

/**
 * Analytics achats/commandes pour le dashboard.
 *
 * Filtres supportés :
 * - from / to : dates locales YYYY-MM-DD
 * - product : id produit
 * - category : catégorie
 * - status : paiement_confirme,facturee (par défaut les deux)
 * - hourFrom / hourTo : plage horaire locale, heure entière 0..23
 *
 * Les commandes conservent un snapshot structuré dans produits_detail.
 * La catégorie est enrichie depuis le catalogue actuel lorsqu'un produitId
 * est disponible. Les anciennes commandes sans détail restent comptées dans
 * les KPI/CA mais sont isolées dans "non_detaillees" pour les analyses produit.
 */
router.get("/achats", requireAdmin, async (req, res) => {
  try {
    const todayStart = startOfTodayLocalUtc();
    const defaultFrom = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
    const from = req.query.from ? localDateToUtc(String(req.query.from)) : defaultFrom;
    const to = req.query.to ? localDateToUtc(String(req.query.to), true) : endOfTodayLocalUtc();
    const productFilter = req.query.product ? String(req.query.product) : "";
    const categoryFilter = req.query.category ? String(req.query.category) : "";
    const statuses = normalizeStatus(req.query.status);
    const hourFrom = req.query.hourFrom === undefined ? null : Math.max(0, Math.min(23, Number(req.query.hourFrom)));
    const hourTo = req.query.hourTo === undefined ? null : Math.max(0, Math.min(23, Number(req.query.hourTo)));

    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      return res.status(400).json({ error: "Période invalide. Utilisez from/to au format YYYY-MM-DD." });
    }

    const [commandes, catalogue] = await Promise.all([loadCommandes(), loadCatalogue()]);
    const productsById = new Map(catalogue.map((p) => [String(p.id), p]));

    const filtered = commandes.filter((commande) => {
      if (!commande?.created_at) return false;
      const createdAt = new Date(commande.created_at);
      if (!Number.isFinite(createdAt.getTime()) || createdAt < from || createdAt >= to) return false;
      if (statuses.length && !statuses.includes(String(commande.statut || ""))) return false;
      const local = localParts(commande.created_at);
      if (hourFrom !== null && Number.isFinite(hourFrom) && local.hour < hourFrom) return false;
      if (hourTo !== null && Number.isFinite(hourTo) && local.hour > hourTo) return false;
      if (!productFilter && !categoryFilter) return true;

      const details = parseDetails(commande.produits_detail);
      return details.some((item) => {
        const product = productsById.get(String(item.produitId ?? item.id ?? ""));
        const category = item.categorie || item.category || product?.categorie || "non_classee";
        return (!productFilter || String(item.produitId ?? item.id ?? "") === productFilter) &&
          (!categoryFilter || category === categoryFilter);
      });
    });

    const dailyMap = new Map();
    const monthlyMap = new Map();
    const productMap = new Map();
    const categoryMap = new Map();
    const hourMap = new Map(Array.from({ length: 24 }, (_, hour) => [hour, { hour, orders: 0, revenue: 0, units: 0 }]));
    const dayPartMap = new Map(DAYPARTS.map((part) => [part.key, { key: part.key, label: part.label, orders: 0, revenue: 0, units: 0 }]));
    const weekdayMap = new Map(WEEKDAYS.map((day) => [day, { weekday: day, orders: 0, revenue: 0, units: 0 }]));

    let revenue = 0;
    let orders = 0;
    let units = 0;
    const customers = new Set();
    let detailedOrders = 0;
    let undetailedOrders = 0;

    const addAgg = (map, key, label = key) => {
      if (!map.has(key)) map.set(key, { key, label, orders: 0, revenue: 0, units: 0 });
      return map.get(key);
    };

    for (const commande of filtered) {
      const total = toNumber(commande.montant_total);
      const local = localParts(commande.created_at);
      const dateKey = localDateKey(local);
      const mKey = monthKey(local);
      const details = parseDetails(commande.produits_detail);
      const matchingDetails = details.filter((item) => {
        const product = productsById.get(String(item.produitId ?? item.id ?? ""));
        const category = item.categorie || item.category || product?.categorie || "non_classee";
        return (!productFilter || String(item.produitId ?? item.id ?? "") === productFilter) &&
          (!categoryFilter || category === categoryFilter);
      });

      if (productFilter || categoryFilter) {
        if (!matchingDetails.length) continue;
      } else if (!details.length) {
        undetailedOrders += 1;
      }

      const detailForFilter = matchingDetails.length
        ? matchingDetails
        : details.length
          ? details
          : [{ produitId: null, nom: "Commandes sans détail produit", quantite: 0, total }];
      const selectedRevenue = (productFilter || categoryFilter)
        ? detailForFilter.reduce((sum, item) => {
            const quantity = Math.max(0, toNumber(item.quantite));
            return sum + toNumber(item.total, quantity * toNumber(item.prixUnitaire));
          }, 0)
        : total;

      revenue += selectedRevenue;
      orders += 1;
      if (commande.phone) customers.add(String(commande.phone));

      const day = addAgg(dailyMap, dateKey, displayDate(dateKey));
      day.orders += 1;
      day.revenue += selectedRevenue;
      const month = addAgg(monthlyMap, mKey, displayMonth(mKey));
      month.orders += 1;
      month.revenue += selectedRevenue;

      const hour = hourMap.get(local.hour);
      hour.orders += 1;
      hour.revenue += selectedRevenue;
      const part = getDayPart(local.hour);
      part.orders += 1;
      part.revenue += selectedRevenue;
      const weekDay = weekdayMap.get(local.weekday);
      weekDay.orders += 1;
      weekDay.revenue += selectedRevenue;

      if (!details.length) {
        continue;
      }
      detailedOrders += 1;

      for (const item of detailForFilter) {
        const quantity = Math.max(0, toNumber(item.quantite));
        const lineTotal = toNumber(item.total, quantity * toNumber(item.prixUnitaire));
        units += quantity;
        day.units += quantity;
        month.units += quantity;
        hour.units += quantity;
        part.units += quantity;
        weekDay.units += quantity;

        const product = productsById.get(String(item.produitId ?? item.id ?? ""));
        const productName = item.nom || product?.nom || `Produit ${item.produitId ?? "inconnu"}`;
        const category = item.categorie || item.category || product?.categorie || "non_classee";
        const productId = String(item.produitId ?? item.id ?? `nom:${productName}`);

        // Pour un filtre produit/catégorie, une commande peut contenir plusieurs
        // lignes : on ne veut pas gonfler les KPI de commande, mais on veut
        // correctement attribuer les lignes aux analyses produit/catégorie.
        const productAgg = addAgg(productMap, productId, productName);
        productAgg.orders += 1;
        productAgg.revenue += lineTotal;
        productAgg.units += quantity;

        const categoryAgg = addAgg(categoryMap, category, category);
        categoryAgg.orders += 1;
        categoryAgg.revenue += lineTotal;
        categoryAgg.units += quantity;
      }
    }

    const sortRevenue = (a, b) => b.revenue - a.revenue;
    const sortChronological = (a, b) => a.key.localeCompare(b.key);
    const categories = [...new Set(catalogue.map((p) => p.categorie).filter(Boolean))].sort();

    res.json({
      filters: {
        from: from.toISOString().slice(0, 10),
        to: new Date(to.getTime() - 1).toISOString().slice(0, 10),
        product: productFilter || null,
        category: categoryFilter || null,
        status: statuses,
        hourFrom,
        hourTo,
      },
      kpis: {
        revenue,
        orders,
        units,
        averageOrderValue: orders ? revenue / orders : 0,
        uniqueCustomers: customers.size,
        detailedOrders,
        undetailedOrders,
      },
      daily: [...dailyMap.values()].sort(sortChronological),
      monthly: [...monthlyMap.values()].sort(sortChronological),
      byProduct: [...productMap.values()].filter((x) => x.key.startsWith("nom:") || productsById.has(x.key)).sort(sortRevenue).slice(0, 30),
      byCategory: [...categoryMap.values()].sort(sortRevenue),
      byHour: [...hourMap.values()],
      byDayPart: [...dayPartMap.values()],
      byWeekday: WEEKDAYS.map((day) => weekdayMap.get(day)),
      options: {
        products: catalogue.map((p) => ({ id: String(p.id), nom: p.nom, categorie: p.categorie })).sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
        categories,
        statuses: ["paiement_confirme", "facturee"],
      },
    });
  } catch (err) {
    log.error("Échec du calcul des stats achats", err);
    res.status(500).json({ error: err?.message || "Erreur interne du serveur" });
  }
});

export default router;
