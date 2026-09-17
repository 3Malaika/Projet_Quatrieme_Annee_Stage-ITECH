import { config } from "../config/env.js";

import { sendWhatsappMessage, sendWhatsappPdf } from "./whatsapp.service.js";

import { formatMontantFcfa } from "./catalogueFormatter.service.js";

import { generateInvoicePdfBuffer, generateNumeroFacture } from "./invoice.service.js";

import { createLogger } from "../utils/logger.js";

import { sendToConfiguredHuman, enqueueEscalation, closeEscalationLog } from "./escalation.service.js";

const log = createLogger("payment");

// Extraction déterministe du nom ET du numéro du compte Mobile Money ayant

// servi au paiement (côté client). Cette fonction appartient au service

// paiement pour éviter une dépendance payment.service -> chat.service qui

// peut créer des problèmes de cycle et surtout pour que le service paiement

// reste autonome au démarrage de Render.

//

// Le numéro est indispensable pour que le collaborateur puisse plus tard

// rattacher sans ambiguïté un paiement reçu (vu depuis son appli Mobile

// Money, qui affiche un nom + un montant) à la bonne conversation cliente

// — surtout lorsque plusieurs clients ont un paiement en attente de

// vérification en même temps (voir matchPendingClient plus bas).

function extractPaymentAccountName(text) {

  const patterns = [

    /(?:au nom de|nom du compte|compte au nom de)\s*[:=]?\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,

    /(?:j['’]ai payé avec|j['’]ai paye avec|payé sur|paye sur)\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,

  ];

  for (const pattern of patterns) {

    const match = text.match(pattern);

    if (match?.[1]) {

      return match[1].trim().replace(/[.!?,;:]+$/, "");

    }

  }

  return null;

}

function extractPaymentAccountNumber(text) {

  // Formats acceptés : 237XXXXXXXXX, +237XXXXXXXXX, 00237XXXXXXXXX, ou un

  // numéro local à 9 chiffres commençant par 6 (courant au Cameroun) — on

  // reconstitue alors le préfixe 237 pour rester cohérent avec le reste du

  // code qui normalise toujours les numéros au format 237XXXXXXXXX.

  const withPrefix = text.match(/(?:\\+|00)?237[\s.-]?[0-9]{9}/);

  if (withPrefix) return withPrefix[0].replace(/[^0-9]/g, "").replace(/^00/, "");

  const local = text.match(/\b6[\s.-]?[0-9](?:[\s.-]?[0-9]){7}\b/);

  if (local) return "237" + local[0].replace(/[^0-9]/g, "");

  return null;

}

function extractPaymentInfo(userMessage) {

  const text = String(userMessage || "");

  return {

    compteMobileMoney: extractPaymentAccountName(text),

    numeroCompteMobileMoney: extractPaymentAccountNumber(text),

  };

}

// Bascule automatique JSON / Supabase, même pattern que le reste du code.

const commandesStore = config.supabaseUrl

  ? await import("../data/commandes.store.supabase.js")

  : await import("../data/commandes.store.js");

const clientsStore = config.supabaseUrl

  ? await import("../data/clients.store.supabase.js")

  : await import("../data/clients.store.js");

// État transitoire du cycle de paiement — PERSISTÉ (fichier JSON local ou

// table Supabase selon le mode actif) pour survivre à un redémarrage du

// serveur. Avant ce correctif, cet état vivait uniquement dans des objets

// JS en mémoire et était perdu à chaque crash/redéploiement, avec le

// risque de "perdre" une commande en cours : un paiement signalé par le

// client mais jamais relancé auprès du collaborateur, une commande payée

// mais jamais relancée pour le délai de livraison, ou une quantité

// choisie par le client jamais rattachée à une commande.

const paymentStateStore = config.supabaseUrl

  ? await import("../data/paymentState.store.supabase.js")

  : await import("../data/paymentState.store.js");

// Panier persistant dédié : le panier n'est plus seulement un champ transitoire du paiement.

// Il possède sa propre table (SQLite `carts` / Supabase `carts`) et reste consultable

// même lorsqu'aucun paiement n'est encore en cours.

const cartStore = config.supabaseUrl

  ? await import("../data/cart.store.supabase.js")

  : await import("../data/cart.store.js");

const carts = await cartStore.loadCarts().catch((err) => {

  log.error("Impossible de charger les paniers persistants", err);

  return {};

});

// Cache mémoire peuplé au démarrage depuis le store persistant, pour ne

// pas relire le disque/la base à chaque message. Chaque mutation est

// néanmoins persistée immédiatement (await) avant de continuer, pour ne

// jamais avoir un état en mémoire plus "avancé" que ce qui est sauvegardé.

const paymentStates = await paymentStateStore.loadPaymentStates();

log.info("État de paiement chargé au démarrage", { clientsEnCours: Object.keys(paymentStates).length });

function getState(phone) {

  return (

    paymentStates[phone] || {

      pendingPayment: null,

      awaitingDelaiCommandeId: null,

      awaitingDeliveryConfirmation: null,

      selections: [],

      awaitingCartAbandonConfirmation: false,

      awaitingPaymentAccountInfo: null,

      // Adresse de livraison texte du client (quartier/ville/repère),

      // demandée une fois avant l'envoi des modalités de paiement puis

      // réutilisée telle quelle pour toute la suite du cycle (vérification

      // du paiement, demande de délai, facture) — voir requestDeliveryAddress

      // / provideDeliveryAddress plus bas.

      deliveryAddress: null,

      awaitingDeliveryAddress: false,

      // Nom du client, demandé une fois avant l'adresse/les modalités de

      // paiement si non déjà connu — voir requestClientName / le tool

      // "nom_client" côté chat.service.js. Le nom lui-même est stocké sur

      // le client (clients.store), ce flag ne sert qu'à savoir qu'on est

      // en train de l'attendre.

      awaitingClientName: false,

      // Mode de logistique choisi par le client (livraison à domicile,
      // expédition hors Yaoundé via agence, ou retrait en boutique) —
      // demandé une fois en texte libre (pas de liste interactive), avant
      // l'adresse : une adresse n'a de sens que pour les deux premiers
      // modes. Le retrait en boutique demande un moment de passage à la
      // place (voir pickupMoment). null = pas encore choisi.
      deliveryMode: null,
      awaitingDeliveryMode: false,
      pickupMoment: null,
      awaitingPickupMoment: false,

    }

  );

}

// Objets légers exposés au collaborateur (via humanCommands.js) pour lui

// permettre de rattacher un paiement reçu à la bonne conversation à partir

// du nom du payeur et/ou du montant, sans connaître forcément le numéro

// WhatsApp du client. `total` est recalculé ici (plutôt que stocké dans

// pendingPayment) pour toujours refléter le panier actuel du client.

export function getPendingPaymentClients() {

  return Object.entries(paymentStates)

    .filter(([, state]) => Boolean(state?.pendingPayment))

    .map(([phone, state]) => ({

      phone,

      ...state.pendingPayment,

      total: getCartTotal(phone),

      // Exposée ici aussi (déjà présente côté getPendingDeliveryDetails) —

      // permet au collaborateur de demander l'adresse d'un client dont le

      // paiement est encore en cours de vérification, pas seulement une

      // fois la livraison à planifier.

      adresseLivraison: state.deliveryAddress || null,

    }));

}

// Sauvegarde l'état d'un client. Si l'état redevient "vide" (plus rien en

// attente pour ce client), on le supprime complètement plutôt que de

// garder une ligne/fichier vide indéfiniment.

async function persistState(phone, state) {

  const isEmpty =

    !state.pendingPayment && !state.awaitingDelaiCommandeId && !state.awaitingDeliveryConfirmation && !state.awaitingCartAbandonConfirmation && !state.awaitingPaymentAccountInfo && !state.deliveryAddress && !state.awaitingDeliveryAddress && !state.awaitingClientName && state.selections.length === 0 && !state.deliveryMode && !state.awaitingDeliveryMode && !state.pickupMoment && !state.awaitingPickupMoment && !state.pendingPaymentMessageAfterAddress;

  if (isEmpty) {

    delete paymentStates[phone];

    await paymentStateStore.deletePaymentState(phone).catch((err) =>

      log.error("Erreur suppression état de paiement persistant", { phone, err })

    );

    return;

  }

  paymentStates[phone] = state;

  await paymentStateStore.upsertPaymentState(phone, state).catch((err) =>

    log.error("Erreur sauvegarde état de paiement persistant", { phone, err })

  );

}

/**

 * Appelé depuis webhook.routes.js dès que le client valide une quantité

 * dans la liste interactive envoyée après une recommandation produit.

 * Ne crée encore aucune commande — la sélection est mémorisée ET

 * PERSISTÉE en attendant la confirmation de paiement, pour ne pas être

 * perdue si le serveur redémarre avant que le client paie.

 */

export async function recordProductSelection(from, selection) {

  const state = getState(from);

  const item = { ...selection, timestamp: Date.now() };

  const currentCart = Array.isArray(carts[from]) ? carts[from] : [];

  const merged = [...currentCart, item];

  carts[from] = merged;

  await cartStore.upsertCart(from, merged);

  state.selections = merged;

  await persistState(from, state);

  log.info("Sélection de quantité mémorisée en attente de paiement", { from, selection });

}

export function getPendingSelections(from) {

  return Array.isArray(carts[from]) ? carts[from] : getState(from).selections;

}

// Construit une description texte lisible (pour l'affichage/la facture) à

// partir des sélections structurées, ex: "2 x Savon noir, 1 x Beurre de karité".

export function getCart(from) {

  return normalizeSelections(Array.isArray(carts[from]) ? carts[from] : getState(from).selections);

}

export function getCartTotal(from) {

  return getCart(from).reduce((sum, item) => sum + (Number(item.total) || 0), 0);

}

export function getCartCount(from) {

  return getCart(from).reduce((sum, item) => sum + (Number(item.quantite) || 0), 0);

}

export function formatCart(from) {

  const items = getCart(from);

  if (!items.length) return "Votre panier est vide.";

  const lines = items.map((item) =>

    `• ${item.quantite} x *${item.nom}* — ${formatMontantFcfa(Number(item.total) || 0)}`

  );

  const total = getCartTotal(from);

  return `🛒 *Votre panier*\n\n${lines.join("\n")}\n\n*Total : ${formatMontantFcfa(total)}*`;

}

export function getAllActiveCarts() {

  return Object.entries(paymentStates)

    .map(([phone, state]) => {

      const selections = normalizeSelections(state?.selections || []);

      if (!selections.length) return null;

      const rawSelections = Array.isArray(state?.selections) ? state.selections : [];

      const updatedAt = rawSelections.reduce((latest, item) => {

        const ts = Number(item?.timestamp) || 0;

        return ts > latest ? ts : latest;

      }, 0);

      return {

        phone,

        items: selections,

        total: selections.reduce((sum, item) => sum + (Number(item.total) || 0), 0),

        count: selections.reduce((sum, item) => sum + (Number(item.quantite) || 0), 0),

        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,

      };

    })

    .filter(Boolean)

    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());

}

export function isAwaitingCartAbandonConfirmation(from) {

  return Boolean(getState(from).awaitingCartAbandonConfirmation);

}

export async function requestCartAbandonConfirmation(from) {

  const state = getState(from);

  if (!getCart(from).length) return false;

  state.awaitingCartAbandonConfirmation = true;

  await persistState(from, state);

  return true;

}

export async function cancelCartAbandonConfirmation(from) {

  const state = getState(from);

  state.awaitingCartAbandonConfirmation = false;

  await persistState(from, state);

}

export async function confirmCartAbandonment(from) {

  const state = getState(from);

  if (!state.awaitingCartAbandonConfirmation) return false;

  state.awaitingCartAbandonConfirmation = false;

  state.selections = [];

  delete carts[from];

  await cartStore.deleteCart(from);

  await persistState(from, state);

  return true;

}

export async function clearCart(from) {

  const state = getState(from);

  state.selections = [];

  delete carts[from];

  await cartStore.deleteCart(from);

  await persistState(from, state);

}

/**
 * Retire un ou plusieurs produits du panier par nom (sans tout vider).
 * Retourne { retires, manquants }.
 */
export async function removeFromCart(from, nomsProduits) {
  const noms = (Array.isArray(nomsProduits) ? nomsProduits : [nomsProduits])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (!noms.length) return { retires: [], manquants: [] };

  const normalize = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const remaining = Array.isArray(carts[from]) ? [...carts[from]] : [];
  const retires = [];
  const manquants = [];

  for (const nom of noms) {
    const cible = normalize(nom);
    if (!cible) continue;
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < remaining.length; i++) {
      const itemNom = normalize(remaining[i]?.nom);
      if (!itemNom) continue;
      if (itemNom === cible || itemNom.includes(cible) || cible.includes(itemNom)) {
        const score = Math.min(itemNom.length, cible.length) / Math.max(itemNom.length, cible.length);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) {
      retires.push(remaining[bestIdx].nom);
      remaining.splice(bestIdx, 1);
    } else {
      manquants.push(nom);
    }
  }

  carts[from] = remaining;
  if (remaining.length) {
    await cartStore.upsertCart(from, remaining);
  } else {
    delete carts[from];
    await cartStore.deleteCart(from);
  }
  const state = getState(from);
  state.selections = remaining;
  await persistState(from, state);
  log.info("Produits retirés du panier", { from, retires, manquants });
  return { retires, manquants };
}

// Suppression complète et définitive de toutes les données de paiement/panier
// d'un client — utilisée par la suppression en cascade d'une fiche client
// (DELETE /api/clients/:phone, voir clients.routes.js). Contrairement à
// persistState() qui ne supprime l'état persistant que s'il redevient
// "vide", ici on supprime INCONDITIONNELLEMENT : panier en cours, paiement
// en attente de vérification, délai de livraison en attente, adresse/nom/
// mode de livraison en cours de collecte — que l'état soit vide ou non.
export async function deleteAllClientPaymentData(from) {

  delete carts[from];

  await cartStore.deleteCart(from).catch((err) =>
    log.error("Erreur suppression panier persistant (suppression client)", { from, err })
  );

  delete paymentStates[from];

  await paymentStateStore.deletePaymentState(from).catch((err) =>
    log.error("Erreur suppression état de paiement persistant (suppression client)", { from, err })
  );

  log.info("Données de paiement/panier supprimées pour ce client", { from });

}

function normalizeSelections(selections) {

  const byProduct = new Map();

  for (const raw of Array.isArray(selections) ? selections : []) {

    const key = String(raw.produitId ?? raw.nom ?? "produit");

    const qty = Number(raw.quantite) || 0;

    const unit = Number(raw.prixUnitaire ?? raw.prix ?? 0) || 0;

    if (!qty) continue;

    const prev = byProduct.get(key);

    if (prev) {

      prev.quantite += qty;

      prev.total = prev.quantite * prev.prixUnitaire;

    } else {

      byProduct.set(key, { ...raw, quantite: qty, prixUnitaire: unit, total: unit * qty });

    }

  }

  return [...byProduct.values()];

}

function describeSelections(selections) {

  return normalizeSelections(selections).map((s) => `${s.quantite} x ${s.nom}`).join(", ");

}

/**

 * Adresse de livraison texte (quartier / ville / repère) demandée au

 * client AVANT de lui communiquer les modalités de paiement, pour que le

 * collaborateur dispose déjà de cette information dès la vérification du

 * paiement — plutôt que de la découvrir seulement au moment de livrer.

* \

 * Volontairement stockée dans l'état de paiement (persisté) plutôt que sur

 * la commande elle-même : cela évite de dépendre d'une colonne dédiée sur

 * la table des commandes (dont le schéma exact n'est pas garanti ici), et

 * elle reste de toute façon disponible tout au long du cycle paiement ->

 * délai -> facture pour ce client, jusqu'à ce qu'elle soit nettoyée en fin

 * de livraison (voir finalizeDelivery).

 */

export function hasDeliveryAddress(from) {

  return Boolean(getState(from).deliveryAddress);

}

export function getDeliveryAddress(from) {

  return getState(from).deliveryAddress || null;

}

export function isAwaitingDeliveryAddress(from) {

  return Boolean(getState(from).awaitingDeliveryAddress);

}

export async function cancelDeliveryAddressRequest(from) {

  const state = getState(from);

  state.awaitingDeliveryAddress = false;

  await persistState(from, state);

}

export async function requestDeliveryAddress(from) {

  const state = getState(from);

  state.awaitingDeliveryAddress = true;

  await persistState(from, state);

  log.info("Adresse de livraison demandée avant l'envoi des modalités de paiement", { from });

  await sendWhatsappMessage(

    from,

    "Avant de vous donner les modalités de paiement, quelle est votre adresse de livraison (quartier, ville, repère) ?"

  );

}

export async function provideDeliveryAddress(from, address) {

  const trimmed = String(address || "").trim();

  if (!trimmed) return false;

  const state = getState(from);

  state.deliveryAddress = trimmed;

  state.awaitingDeliveryAddress = false;

  // S'il y avait un signalement de paiement en attente uniquement parce
  // que la logistique manquait (voir requestPaymentConfirmation), on le
  // reprend automatiquement maintenant que l'adresse est connue.
  const resumeMessage = state.pendingPaymentMessageAfterAddress || null;
  state.pendingPaymentMessageAfterAddress = null;

  await persistState(from, state);

  log.info("Adresse de livraison enregistrée", { from, adresse: trimmed });

  if (resumeMessage) {
    log.info("Reprise de la vérification de paiement après réception de l'adresse", { from });
    await requestPaymentConfirmation(from, resumeMessage);
  }

  return true;

}

// --- Mode de logistique (livraison / expédition / retrait en boutique) ---
//
// Demandé UNE SEULE FOIS, avant l'adresse, en texte libre (aucune liste
// interactive WhatsApp : le client doit pouvoir répondre librement, comme
// pour n'importe quelle autre question du bot). provideDeliveryModeFromText
// interprète la réponse par mots-clés simples ; si elle est ambiguë, on
// redemande plutôt que de deviner.
//
// Selon le choix :
//   - "livraison"  ou "expedition" -> une adresse est requise (l'adresse
//     d'expédition est une adresse d'agence de voyage, mais techniquement
//     stockée dans le même champ deliveryAddress).
//   - "retrait_boutique" -> AUCUNE adresse n'est requise ; à la place, on
//     demande le moment auquel le client passera récupérer sa commande.
const DELIVERY_MODES = ["livraison", "expedition", "retrait_boutique"];

// Exporté pour permettre une extraction déterministe secondaire
// (ex: après un ajout_panier sur un message composé "3 chouquettes + livraison")
// sans donner le tool mode_livraison à Groq.
export function detectDeliveryModeFromText(text) {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Point de rencontre externe ("passer récupérer au carrefour fouda") =
  // livraison à ce lieu, PAS retrait en boutique Sekhmet.
  const lieuExterne =
    /carrefour|quartier|rond[\s-]?point|marche|marché|station|pharmacie|ecole|école|lycee|lycée|universite|université|hotel|hôtel|chez\s+\w+|immeuble|residence|résidence/.test(
      t
    ) ||
    /(?:passer|venir)\s+(?:chercher|recuperer|récupérer)\s+(?:au|à|a|chez)\s+\w+/.test(t);

  if (lieuExterne && /(?:passer|venir)\s+(?:chercher|recuperer|récupérer)|livraison|livrer|recuperer|récupérer/.test(t)) {
    return "livraison";
  }

  // Retrait boutique uniquement si le client vise clairement le magasin
  // (sans lieu externe de type carrefour/quartier).
  if (
    /(?:en\s+)?boutique|retrait\s+(?:en\s+)?boutique|sur\s+place|en\s+magasin|venir\s+(?:à\s+la\s+)?boutique|passer\s+(?:à\s+la\s+)?boutique/.test(
      t
    )
  ) {
    return "retrait_boutique";
  }
  // "passer récupérer" / "je viens chercher" SANS lieu externe → boutique
  if (
    !lieuExterne &&
    /(?:passer|venir)\s+(?:chercher|recuperer|récupérer)|je\s+(?:viens|passerai|vais\s+passer)/.test(t)
  ) {
    return "retrait_boutique";
  }

  if (/expedition|agence\s+de\s+voyage|hors\s+yaounde|province|autre\s+ville/.test(t)) return "expedition";
  if (/livraison|domicile|livrer|a\s+la\s+maison|chez\s+moi|faire\s+livrer/.test(t)) return "livraison";
  return null;
}

/**
 * Extraction déterministe d'une adresse / quartier dans un message composé
 * (ex: "livraison au quartier foudas", "livrer à Nkolbisson").
 * Retourne null si rien de fiable — on ne devine jamais.
 */
export function extractDeliveryAddressFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const patterns = [
    // "passer récupérer au carrefour fouda", "venir chercher à Nkolbisson"
    /(?:passer|venir)\s+(?:chercher|r[eé]cup[eé]rer)\s+(?:au|à|a|chez)\s+(.+?)(?=\s+(?:je|j['’]|et\s+je|pour|paiement|payer|comment|momo|mobile|num[eé]ro|infos?\b)|[.!?,;]|$)/i,
    // "livraison au quartier foudas", "livrer à Nkolbisson", "domicile chez moi à ..."
    /(?:livraison|livrer|domicile|expedition|exp[eé]dier)\s+(?:au|à|a|chez)\s+(.+?)(?=\s+(?:je|j['’]|et\s+je|pour|paiement|payer|comment|momo|mobile|num[eé]ro|infos?\b)|[.!?,;]|$)/i,
    // "adresse : quartier foudas", "adresse de livraison Nkolbisson"
    /adresse(?:\s+de\s+livraison)?\s*[:=]?\s+(.+?)(?=\s+(?:je|j['’]|et\s+je|pour|paiement|payer|comment)|[.!?,;]|$)/i,
    // "au carrefour fouda", "carrefour X"
    /(?:^|\s)((?:au\s+)?carrefour\s+[A-Za-zÀ-ÖØ-öø-ÿ0-9'’ -]{2,40})(?=\s+(?:je|j['’]|et\s+je|pour|paiement|payer|comment)|[.!?,;]|$)/i,
    // "quartier foudas" / "au quartier X" isolé dans la phrase
    /(?:^|\s)((?:au\s+)?quartier\s+[A-Za-zÀ-ÖØ-öø-ÿ0-9'’ -]{2,40})(?=\s+(?:je|j['’]|et\s+je|pour|paiement|payer|comment)|[.!?,;]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    let adresse = match[1].trim().replace(/[.!?,;:]+$/, "").replace(/\s+/g, " ");
    // Écarte les captures trop courtes ou qui ressemblent à autre chose
    if (adresse.length < 3 || adresse.length > 120) continue;
    if (/^(?:paiement|payer|momo|mobile|bouteille|produit|panier)/i.test(adresse)) continue;
    return adresse;
  }
  return null;
}

export function getDeliveryMode(from) {
  return getState(from).deliveryMode || null;
}
export function hasDeliveryMode(from) {
  return Boolean(getState(from).deliveryMode);
}
export function isAwaitingDeliveryMode(from) {
  return Boolean(getState(from).awaitingDeliveryMode);
}

export async function requestDeliveryMode(from) {
  const state = getState(from);
  state.awaitingDeliveryMode = true;
  await persistState(from, state);
  log.info("Mode de logistique demandé (texte libre)", { from });
  await sendWhatsappMessage(
    from,
    "Avant de continuer, comment souhaitez-vous recevoir votre commande ? Livraison à domicile, expédition (si vous n'êtes pas à Yaoundé), ou retrait en boutique ?"
  );
}

// Retourne true si un mode a été reconnu et enregistré, false si la
// réponse était ambiguë (dans ce cas on redemande, on ne devine jamais).
export async function provideDeliveryModeFromText(from, text) {
  const raw = String(text || "").trim();
  // Code enum déjà résolu (ex: "livraison") OU phrase libre à interpréter.
  let mode = DELIVERY_MODES.includes(raw) ? raw : detectDeliveryModeFromText(raw);
  if (!mode || !DELIVERY_MODES.includes(mode)) {
    await sendWhatsappMessage(
      from,
      "Je n'ai pas bien compris : souhaitez-vous une livraison à domicile, une expédition, ou un retrait en boutique ?"
    );
    return false;
  }
  const state = getState(from);
  state.deliveryMode = mode;
  state.awaitingDeliveryMode = false;
  // Si le client change d'avis (ex: retrait demandé puis "en fait livraison"),
  // on annule l'attente / le moment de retrait boutique pour ne pas bloquer.
  if (mode !== "retrait_boutique") {
    state.awaitingPickupMoment = false;
    state.pickupMoment = null;
  }
  await persistState(from, state);
  log.info("Mode de logistique enregistré", { from, mode });
  return true;
}

export function hasPickupMoment(from) {
  return Boolean(getState(from).pickupMoment);
}
export function isAwaitingPickupMoment(from) {
  return Boolean(getState(from).awaitingPickupMoment);
}
export function getPickupMoment(from) {
  return getState(from).pickupMoment || null;
}

export async function requestPickupMoment(from) {
  const state = getState(from);
  state.awaitingPickupMoment = true;
  await persistState(from, state);
  log.info("Moment de retrait en boutique demandé", { from });
  await sendWhatsappMessage(
    from,
    "Avant de vous donner les modalités de paiement, à quel moment pensez-vous passer récupérer votre commande en boutique (ex: \"aujourd'hui 17h\", \"demain matin\") ?"
  );
}

export async function providePickupMoment(from, moment) {
  const trimmed = String(moment || "").trim();
  if (!trimmed) return false;
  const state = getState(from);
  state.pickupMoment = trimmed;
  state.awaitingPickupMoment = false;
  const resumeMessage = state.pendingPaymentMessageAfterAddress || null;
  state.pendingPaymentMessageAfterAddress = null;
  await persistState(from, state);
  log.info("Moment de retrait en boutique enregistré", { from, moment: trimmed });
  if (resumeMessage) {
    log.info("Reprise de la vérification de paiement après réception du moment de retrait", { from });
    await requestPaymentConfirmation(from, resumeMessage);
  }
  return true;
}

// Vue d'ensemble utilisée partout où on doit savoir si les informations
// logistiques nécessaires sont complètes, sans se soucier du mode choisi.
export function hasRequiredLogisticsInfo(from) {
  const mode = getDeliveryMode(from);
  if (!mode) return false;
  if (mode === "retrait_boutique") return hasPickupMoment(from);
  return hasDeliveryAddress(from);
}

// Ligne d'affichage prête à l'emploi pour les récapitulatifs envoyés au
// collaborateur (escalade paiement) ou utilisée dans la facture.
export function formatLogisticsLine(from) {
  const mode = getDeliveryMode(from);
  if (mode === "retrait_boutique") {
    return `Retrait en boutique — moment prévu : ${getPickupMoment(from) || "non renseigné"}`;
  }
  if (mode === "expedition") {
    return `Expédition (agence de voyage) — adresse/agence : ${getDeliveryAddress(from) || "non renseignée"}`;
  }
  return `Livraison à domicile — adresse : ${getDeliveryAddress(from) || "non renseignée"}`;
}

// --- Réponses oui/non en texte libre, utilisées pour les confirmations
// binaires déjà posées par le code (abandon de panier, confirmation du
// numéro de livraison) — remplace d'anciennes regex strictes par un jeu de
// formulations naturelles courantes, sans appel Groq (cohérent avec la
// volonté de garder Groq hors des décisions déterministes).
const POSITIVE_WORDS = ["oui", "ok", "d'accord", "daccord", "c'est bon", "cest bon", "vas-y", "vasy", "exact", "c'est ca", "cest ca", "bien sur", "bien sûr", "yes"];
const NEGATIVE_WORDS = ["non", "nan", "annule", "garde", "laisse tomber", "pas", "no"];

export function isPositiveResponse(text) {
  const t = String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return POSITIVE_WORDS.some((w) => t === w || t.startsWith(`${w} `) || t.startsWith(`${w},`));
}
export function isNegativeResponse(text) {
  const t = String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return NEGATIVE_WORDS.some((w) => t === w || t.startsWith(`${w} `) || t.startsWith(`${w},`));
}

// --- Nom du client, requis avant de valider une commande (voir procédures :

// "Informations obligatoires à collecter avant de valider une commande :

// nom, numéro de téléphone, ville/quartier de livraison, produit exact,

// quantité"). Même schéma que l'adresse de livraison ci-dessus : on

// interrompt sendCartPaymentInstructions tant que le nom manque, puis on la

// rappelle une fois le nom fourni (voir le tool "nom_client" côté

// chat.service.js et son traitement dans webhook.routes.js).

export function isAwaitingClientName(from) {

  return Boolean(getState(from).awaitingClientName);

}

export async function requestClientName(from) {

  const state = getState(from);

  state.awaitingClientName = true;

  await persistState(from, state);

  log.info("Nom du client demandé avant de valider la commande", { from });

  await sendWhatsappMessage(from, "Avant de valider votre commande, quel est votre nom ?");

}

export async function clearAwaitingClientName(from) {

  const state = getState(from);

  state.awaitingClientName = false;

  await persistState(from, state);

}

/**

 * Étape 1 — le client dit avoir payé : on extrait le nom du compte Mobile

 * Money s'il est mentionné, on répond au client par un message neutre (il

 * ne doit jamais savoir qu'un humain est sollicité), et on transmet la

 * demande de vérification au collaborateur. Le bot NE VALIDE RIEN à ce

 * stade : ni commande, ni facture — tout attend une confirmation explicite

 * du collaborateur, qui peut prendre son temps (il vérifie peut-être

 * plusieurs paiements en parallèle). Cette demande en attente est

 * persistée : si le serveur redémarre avant la confirmation, elle n'est

 * pas perdue silencieusement (consultable via getPendingSelections /

 * l'état persistant, et le message envoyé au collaborateur suffit pour

 * relancer manuellement /paiement_recu de toute façon).

 */

/**

 * Étape 1 (suite) — une fois qu'on dispose au minimum du NUMÉRO du compte

 * Mobile Money ayant servi au paiement (le nom est un plus mais ne suffit

 * jamais seul : plusieurs clients peuvent partager un même nom, très peu

 * partagent un même numéro), on notifie le client et on transmet la

 * vérification au collaborateur. C'est ce couple numéro+nom, avec le

 * montant du panier, qui permettra ensuite à handleHumanCommand /

 * matchPendingClient de rattacher sans ambiguïté la confirmation du

 * collaborateur à cette conversation même si plusieurs paiements sont en

 * vérification en parallèle.

 */

async function escalatePaymentVerification(from, userMessage, { compteMobileMoney, numeroCompteMobileMoney }) {

  // Garde-fou : aucune escalade de paiement si le panier est vide
  // et qu'aucun paiement n'est déjà en attente.
  // On conserve le cas pendingPayment pour ne pas casser un cycle
  // de paiement déjà engagé.
  const cartItems = getCart(from);
  const state = getState(from);

  if (!cartItems.length && !state.pendingPayment) {
    log.warn(
      "Escalade de paiement bloquée : panier vide et aucun paiement en attente",
      { from, userMessage }
    );

    await sendWhatsappMessage(
      from,
      "Je ne trouve pas de commande en attente de paiement pour vous en ce moment 🙏 Si vous souhaitez passer une commande ou avez une autre question, je suis là !"
    );

    return false;
  }

  state.awaitingPaymentAccountInfo = null;

  state.pendingPayment = { userMessage, compteMobileMoney, numeroCompteMobileMoney, timestamp: Date.now() };

  await persistState(from, state);

  const cart = formatCart(from);

  const total = getCartTotal(from);

  // Nom du client (s'il est déjà connu) et adresse de livraison (demandée

  // avant l'envoi des modalités de paiement, voir requestDeliveryAddress) :

  // toutes deux transmises au collaborateur pour qu'il ait un dossier

  // complet dès la demande de vérification, sans avoir à les redemander.

  const client = await clientsStore.getClient(from).catch(() => null);

  const nomClient = client?.nom || null;

  const logistiqueLigne = formatLogisticsLine(from);

  log.info("Demande de confirmation de paiement (en attente du collaborateur)", {

    from, compteMobileMoney, numeroCompteMobileMoney, total, lignes: getCart(from).length

  });

  await sendWhatsappMessage(

    from,

    `Merci ! Je vérifie la réception de votre paiement, un instant 🙏\n\n${cart}`

  );

  // Le numéro du compte Mobile Money ayant payé est la clé UNIQUE (au

  // Cameroun) qui permet de rattacher sans ambiguïté une confirmation du

  // collaborateur à cette conversation, même quand plusieurs paiements sont

  // en vérification en même temps — voir matchPendingClient dans

  // humanCommands.js. Le nom déclaré par le client n'est qu'un complément

  // pratique pour que le collaborateur puisse s'y référer en langage

  // naturel ; il ne remplace jamais le numéro.

  const compteLigne = [

    `Numéro du compte de paiement (clé unique) : ${numeroCompteMobileMoney}`,

    compteMobileMoney ? `Nom attendu sur ce compte : ${compteMobileMoney}` : null,

  ].filter(Boolean).join("\n");

  try {

    await enqueueEscalation(from, userMessage, {

      notifyClient: false,

      agentMessage: `💰 Paiement à vérifier — conversation ${from}${nomClient ? ` (client : ${nomClient})` : ""}\n\nPanier${nomClient ? ` de ${nomClient}` : ""} :\n${cart}\n\nMontant à recevoir : ${formatMontantFcfa(total)}\n${compteLigne}\n${logistiqueLigne}\n\nDernier message : "${userMessage}"\n\nRépondez naturellement dès que vous avez vérifié (reçu ou non reçu, avec le montant si reçu) — je comprends vos messages en langage courant.`,

    });

  } catch (err) {

    log.error("Impossible de transmettre la vérification de paiement au collaborateur", { from, error: err?.message || String(err) });

    await sendWhatsappMessage(from, "Votre demande est bien enregistrée. Je rencontre toutefois un problème pour joindre le collaborateur chargé de vérifier le paiement.");

  }

}

export function isAwaitingPaymentAccountInfo(from) {

  return Boolean(getState(from).awaitingPaymentAccountInfo);

}

export function getAwaitingState(from) {

  const s = getState(from);

  return {

    awaitingDeliveryAddress:          Boolean(s.awaitingDeliveryAddress),

    awaitingPaymentAccountInfo:       Boolean(s.awaitingPaymentAccountInfo),

    awaitingCartAbandonConfirmation:  Boolean(s.awaitingCartAbandonConfirmation),

    awaitingDeliveryConfirmation:     Boolean(s.awaitingDeliveryConfirmation),

    awaitingClientName:               Boolean(s.awaitingClientName),
    awaitingDeliveryMode:             Boolean(s.awaitingDeliveryMode),
    awaitingPickupMoment:             Boolean(s.awaitingPickupMoment),

  };

}

export async function cancelPaymentAccountInfoRequest(from) {

  const state = getState(from);

  state.awaitingPaymentAccountInfo = null;

  await persistState(from, state);

}

/**

 * Le client a répondu à notre relance lui demandant le numéro (et

 * idéalement le nom) du compte Mobile Money utilisé pour payer. Si le

 * numéro est toujours introuvable dans sa réponse, on relance une seule

 * fois avec un message plus directif avant d'escalader quand même (pour ne

 * jamais bloquer indéfiniment un client de bonne foi qui ne sait pas

 * formuler la demande).

 */

export async function provideMobileMoneyAccountInfo(from, userMessage) {

  const state = getState(from);

  const awaiting = state.awaitingPaymentAccountInfo;

  log.info("provideMobileMoneyAccountInfo appelé", { from, hasAwaiting: Boolean(awaiting), userMessage });

  if (!awaiting) {

    log.warn("provideMobileMoneyAccountInfo: aucun état d'attente", { from });

    return false;

  }

  const { compteMobileMoney, numeroCompteMobileMoney } = extractPaymentInfo(userMessage);

  const originalMessage = awaiting.originalMessage || userMessage;

  // Vérifier si l'utilisateur confirme avec une réponse simple comme "oui", "c'est ça"

  const userResponse = String(userMessage || "").trim().toLowerCase();

  const confirmations = ["oui", "c'est ça", "c'est bien ça", "oui c'est ça", "oui c'est bien ça", "yes", "c'est bon", "c'est exact", "exactement", "je l'ai fait", "c'est fait", "c'est ok", "ok", "d'accord"];

  const isConfirmed = confirmations.some(conf => 

    userResponse.includes(conf) || 

    conf.includes(userResponse)

  );

  log.info("Vérification confirmation", { from, userResponse, isConfirmed, numeroCompteMobileMoney });

  // Si l'utilisateur confirme avec une réponse simple, utiliser le numéro WhatsApp

  if (isConfirmed && !numeroCompteMobileMoney) {

    // Le numéro WhatsApp est déjà formaté comme 237XXXXXXXXX

    const numeroWhatsApp = from; // C'est déjà le bon format

    log.info("Confirmation détectée, utilisation du numéro WhatsApp", { from, numeroWhatsApp });

    await escalatePaymentVerification(from, originalMessage, {

      compteMobileMoney: compteMobileMoney || "NOM NON FOURNI",

      numeroCompteMobileMoney: numeroWhatsApp,

    });

    return true;

  }

  if (!numeroCompteMobileMoney) {

    if (awaiting.attempts >= 1) {

      // Deuxième échec : on n'insiste plus, on transmet quand même au

      // collaborateur avec un avertissement explicite plutôt que de

      // laisser le client bloqué sans réponse.

      log.info("Deuxième tentative sans numéro, escalade quand même", { from });

      await escalatePaymentVerification(from, originalMessage, {

        compteMobileMoney,

        numeroCompteMobileMoney: "NON COMMUNIQUÉ",

      });

      return true;

    }

    state.awaitingPaymentAccountInfo = { originalMessage, attempts: (awaiting.attempts || 0) + 1, timestamp: Date.now() };

    await persistState(from, state);

    log.info("Numéro non trouvé, demande à nouveau", { from, attempts: state.awaitingPaymentAccountInfo.attempts });

    await sendWhatsappMessage(

      from,

      "Je n'ai pas trouvé de numéro. Pouvez-vous m'envoyer le numéro du compte Mobile Money qui a servi à payer, au format 6XXXXXXXX (et le nom du compte si possible) ?"

    );

    return true;

  }

  log.info("Numéro trouvé, escalade", { from, numeroCompteMobileMoney });

  await escalatePaymentVerification(from, originalMessage, { compteMobileMoney, numeroCompteMobileMoney });

  return true;

}

/**

 * Étape 1 — le client dit avoir payé. Avant de déranger le collaborateur,

 * on vérifie que le NUMÉRO du compte Mobile Money ayant servi au paiement

 * est identifiable dans son message (le nom seul ne permet pas de

 * distinguer deux clients de manière fiable). S'il manque, on le demande

 * au client — sans encore rien transmettre au collaborateur — plutôt que

 * d'escalader une vérification incomplète comme c'était le cas

 * auparavant. Le bot ne valide toujours rien à ce stade : ni commande, ni

 * facture — tout attend une confirmation explicite du collaborateur.

 */

export async function requestPaymentConfirmation(from, userMessage) {

  // Garde-fou : un signalement de paiement n'a de sens que s'il y a

  // effectivement quelque chose à payer (panier non vide) ou qu'une

  // vérification est déjà en cours pour ce client (pendingPayment). Sans ce

  // garde-fou, un message mal classé par le modèle (ex: un "oui" en tête de

  // phrase, ou toute question posée juste après une commande finalisée)

  // déclenchait à tort tout le mécanisme de vérification de paiement —

  // jusqu'à créer une escalade "paiement" fantôme (panier vide, montant 0)

  // vers le collaborateur, alors que le client n'avait rien à payer. Ce

  // garde-fou ne change rien au cas normal : un vrai signalement de

  // paiement arrive toujours avec un panier non vide.

  const guardState = getState(from);

  if (!getCart(from).length && !guardState.pendingPayment) {

    log.warn("Signalement de paiement ignoré : aucun panier ni vérification en cours pour ce client", { from, userMessage });

    await sendWhatsappMessage(

      from,

      "Je ne trouve pas de commande en attente de paiement pour vous en ce moment 🙏 Si vous voulez passer une commande ou avez une autre question, je suis là !"

    );

    return;

  }

  // Garde-fou : ne JAMAIS escalader une confirmation de paiement sans les
  // informations logistiques nécessaires — une adresse pour
  // livraison/expédition, ou un moment de passage pour un retrait en
  // boutique — quel que soit le chemin qui a mené ici. On oriente vers
  // l'étape manquante précise plutôt que de redemander une adresse même
  // quand ce n'en est pas une qui manque (cas du retrait boutique).
  if (!hasRequiredLogisticsInfo(from)) {
    guardState.pendingPaymentMessageAfterAddress = userMessage;
    await persistState(from, guardState);
    if (!hasDeliveryMode(from)) {
      if (!guardState.awaitingDeliveryMode) await requestDeliveryMode(from);
    } else if (getDeliveryMode(from) === "retrait_boutique") {
      if (!guardState.awaitingPickupMoment) await requestPickupMoment(from);
    } else {
      if (!guardState.awaitingDeliveryAddress) await requestDeliveryAddress(from);
    }
    return;
  }

  const { compteMobileMoney, numeroCompteMobileMoney } = extractPaymentInfo(userMessage);

  if (!numeroCompteMobileMoney) {

    const state = getState(from);

    state.awaitingPaymentAccountInfo = { originalMessage: userMessage, attempts: 0, timestamp: Date.now() };

    await persistState(from, state);

    // Simplifier : suggérer le numéro WhatsApp comme option par défaut

    // Formater le numéro pour l'affichage (237XXXXXXXXX -> XXXXXXXXX)

    const whatsappNumber = from.replace(/^237/, '');

    await sendWhatsappMessage(

      from,

      `Merci pour votre paiement ! 😊\n\nPour vérifier rapidement, voulez-vous que j'utilise le numéro :\n*${whatsappNumber}* ?\n\nSi OUI, répondez simplement "oui" ou "c'est ça".\nSi NON, écrivez le bon numéro (format 6XXXXXXXX).`

    );

    return;

  }

  await escalatePaymentVerification(from, userMessage, { compteMobileMoney, numeroCompteMobileMoney });

}

/**

 * Étape 2 — le collaborateur confirme EXPLICITEMENT avoir reçu le paiement

 * (commande /paiement_recu) : seulement à ce moment la commande existe.

 * On lui demande ensuite le délai de livraison, en exigeant qu'il précise

 * le numéro du client dans sa réponse (/delai <numero> <texte>) — comme

 * plusieurs paiements peuvent être en cours de vérification en même temps,

 * une réponse en texte libre sans numéro serait ambiguë.

* \

 * `produitsDescription` est OPTIONNEL : si le collaborateur ne la précise

 * pas, on la reconstruit automatiquement à partir des choix de quantité

 * que le client a validés dans les listes interactives WhatsApp (voir

 * recordProductSelection). Ces choix structurés (produit_id, quantité,

 * prix) sont eux-mêmes persistés tels quels dans la commande via le champ

 * `produits`, pour enregistrer la description lisible de la commande sans dépendre

 * d'une colonne produits_detail absente du schéma Supabase réel.

 */

export async function confirmPayment(from, montant, produitsDescription, numeroCompteMobile) {

  const state = getState(from);

  // Le numéro du compte Mobile Money ayant reçu le paiement est obligatoire

  // avant de créer la commande. Le nom du client ne remplace jamais ce numéro.

  const compte = String(numeroCompteMobile || "").trim();

  if (!/^237[0-9]{9}$/.test(compte)) {

    throw new Error("Le numéro du compte Mobile Money ayant reçu le paiement est obligatoire avant de créer la commande. Indiquez-le au format 237XXXXXXXXX.");

  }

  state.pendingPayment = null;

  await closeEscalationLog(from).catch(() => {});

  const client = await clientsStore.getClient(from);

  const selections = normalizeSelections(state.selections);

  const produits = produitsDescription || (selections.length ? describeSelections(selections) : null);

  const totalSelection = selections.reduce((sum, item) => sum + (Number(item.total) || 0), 0);

  const montantFinal = Number(montant) || totalSelection;

  // Le bot peut détecter par lui-même un écart entre la somme annoncée

  // reçue et le total réel du panier — sans attendre que le collaborateur

  // s'en rende compte. On ne bloque pas la confirmation (le collaborateur a

  // vérifié son appli Mobile Money, source de vérité), mais on le signale

  // clairement dans le message renvoyé plutôt que dans les seuls logs.

  const montantMismatch = Boolean(

    selections.length && totalSelection > 0 && Number.isFinite(Number(montant)) && Number(montant) !== totalSelection

  );

  if (montantMismatch) {

    log.warn("Écart entre montant confirmé et total des produits sélectionnés", { from, montantConfirme: montant, totalSelection });

  }

  if (!produits) {

    // On persiste quand même la levée du pendingPayment avant de sortir en

    // erreur, pour ne pas laisser une demande de vérification "fantôme".

    await persistState(from, state);

    throw new Error(

      "Aucune description de produits fournie et aucune sélection de quantité en attente pour ce client."

    );

  }

  const commande = await commandesStore.createCommande({

    phone: from,

    nom_client: client?.nom || null,

    produits,

    montant_total: montantFinal,

    compte_mobile_money: compte,

    statut: "paiement_confirme",

  });

  state.selections = [];

  delete carts[from];

  await cartStore.deleteCart(from);

  state.awaitingDelaiCommandeId = commande.id;

  state.awaitingDeliveryConfirmation = null;

  await persistState(from, state);

  log.info("Paiement confirmé, en attente du délai de livraison", {

    from,

    commandeId: commande.id,

    selectionsPersistees: selections.length,

  });

  // Le client n'était jusqu'ici jamais notifié à cette étape : il ne

  // recevait un message que plus tard, au moment du /delai (facture PDF).

  // S'il ne recevait pas de réponse rapide après avoir signalé son

  // paiement, rien ne lui confirmait que le collaborateur l'avait bien

  // validé de son côté.

  await sendWhatsappMessage(

    from,

    `✅ Votre paiement de ${formatMontantFcfa(montantFinal)} a bien été reçu et votre commande est confirmée. Je reviens vers vous dans un instant avec le délai de livraison 🙏`

  ).catch((err) => log.error("Échec de la notification de paiement confirmé au client", { from, error: err?.message || String(err) }));

  // Récapitulatif complet renvoyé au collaborateur avant de lui demander le

  // délai : commande (contenu), adresse de livraison, et l'alerte d'écart

  // de montant si le bot en a détecté un — tout ce dont il a besoin pour

  // valider en un coup d'œil avant de répondre au client.

  const logistiqueLigne = formatLogisticsLine(from);

  const mismatchLigne = montantMismatch

    ? `\n⚠️ Attention : le montant indiqué (${formatMontantFcfa(Number(montant))}) ne correspond pas au total du panier (${formatMontantFcfa(totalSelection)}). Vérifiez avant de continuer.`

    : "";

  await sendToConfiguredHuman(

    `✅ Paiement confirmé pour ${from} (${formatMontantFcfa(montantFinal)}). Escalade clôturée automatiquement.${mismatchLigne}\n\nCommande : ${produits}\n${logistiqueLigne}\n\nQuel est le délai de livraison ? Répondez simplement (ex: "2 heures", "demain matin"), ou avec /delai ${from} <texte>. Je transmettrai le délai au client et lui enverrai directement sa facture.`,

    from

  );

  return commande;

}

/**

 * Le collaborateur indique que le paiement n'a PAS été reçu : le bot

 * l'annonce au client, aucune commande n'est créée, aucune facture n'est

 * générée.

 */

export async function rejectPayment(from, raison) {

  const state = getState(from);

  state.pendingPayment = null;

  await persistState(from, state);

  await closeEscalationLog(from).catch(() => {});

  log.info("Paiement refusé/non trouvé", { from, raison });

  await sendWhatsappMessage(

    from,

    "Nous n'avons pas encore reçu votre paiement de notre côté. Pourriez-vous vérifier et réessayer, ou nous envoyer une capture de la transaction ?"

  );

}

/**

 * Étape 3 — le collaborateur indique le délai de livraison pour UN client

 * précis (/delai <numero> <texte>) : on finalise la commande, génère la

 * facture PDF et l'envoie directement au client sur WhatsApp, avec le délai

 * annoncé, puis on clôture.

 */

export function getPendingDeliveryClients() {

  return Object.entries(paymentStates)

    .filter(([, state]) => Boolean(state?.awaitingDelaiCommandeId))

    .map(([phone]) => phone);

}

// Version détaillée pour l'interprétation en langage naturel du

// collaborateur : quand celui-ci annonce un délai sans préciser de numéro

// (« peut-être 1 heure »), il faut pouvoir le confronter au(x) commande(s)

// réellement en attente d'un délai — produits, montant, compte Mobile

// Money ayant payé — plutôt que de deviner. Voir matchPendingDeliveryClient

// dans humanCommands.js.

export async function getPendingDeliveryDetails() {

  const entries = Object.entries(paymentStates).filter(([, state]) => Boolean(state?.awaitingDelaiCommandeId));

  const details = await Promise.all(entries.map(async ([phone, state]) => {

    const commande = await commandesStore.getCommande(state.awaitingDelaiCommandeId).catch(() => null);

    return {

      phone,

      commandeId: state.awaitingDelaiCommandeId,

      produits: commande?.produits || null,

      montant: Number(commande?.montant_total) || null,

      // Nom conservé pour compat (voir humanCommands.js) — malgré son nom,

      // ce champ contient en réalité le NUMÉRO du compte Mobile Money ayant

      // payé (compte_mobile_money), pas un nom.

      compteMobileMoney: commande?.compte_mobile_money || null,

      // Alias explicite : c'est la clé unique (numéro de compte Mobile

      // Money, unique au Cameroun) permettant de rattacher sans ambiguïté

      // une réponse du collaborateur à CETTE commande, même quand

      // plusieurs livraisons attendent un délai en même temps.

      numeroCompteMobileMoney: commande?.compte_mobile_money || null,

      adresseLivraison: state.deliveryAddress || null,

    };

  }));

  return details;

}

export function findPendingDeliveryClient() {

  const phones = getPendingDeliveryClients();

  return phones.length === 1 ? phones[0] : null;

}

export function isAwaitingDeliveryConfirmation(from) {

  return Boolean(getState(from).awaitingDeliveryConfirmation);

}

export async function confirmDeliveryPhone(from, confirmed) {

  const state = getState(from);

  const pending = state.awaitingDeliveryConfirmation;

  if (!pending) return false;

  if (!confirmed) {

    state.awaitingDeliveryConfirmation = null;

    await persistState(from, state);

    await sendWhatsappMessage(from, "D'accord. Quel est le numéro à utiliser pour la livraison ?");

    return false;

  }

  state.awaitingDeliveryConfirmation = null;

  state.awaitingDelaiCommandeId = null;

  await persistState(from, state);

  return finalizeDelivery(from, pending.commandeId, pending.delaiText);

}

async function finalizeDelivery(from, commandeId, delaiText) {

  log.info("Numéro de livraison confirmé, finalisation de la facture", { from, commandeId, delaiText });

  // Lue avant toute chose : c'est le dernier point du cycle où l'adresse

  // (mémorisée depuis la demande de paiement) est encore utile — elle est

  // nettoyée de l'état juste après, une fois la facture envoyée.

  // La facture garde un unique champ "adresse_livraison" (invoice.service.js
  // n'a pas été modifié) : pour un retrait en boutique, on y indique le
  // moment de passage plutôt qu'une adresse inexistante.
  const modeLivraisonFacture = getDeliveryMode(from);
  const adresse = modeLivraisonFacture === "retrait_boutique"
    ? `Retrait en boutique (${getPickupMoment(from) || "moment non renseigné"})`
    : getDeliveryAddress(from);

  try {

    const numeroFacture = generateNumeroFacture();

    const commande = await commandesStore.updateCommande(commandeId, {

      delai_livraison: delaiText,

      statut: "facturee",

      numero_facture: numeroFacture,

    });

    // adresse_livraison n'est ajoutée qu'à l'objet transmis au générateur de

    // PDF (voir invoice.service.js), pas persistée sur la commande — on

    // évite ainsi de dépendre d'une colonne dédiée dont l'existence n'est

    // pas garantie sur la table des commandes.

    const pdfBuffer = await generateInvoicePdfBuffer({ ...commande, adresse_livraison: adresse });

    await sendWhatsappPdf(from, pdfBuffer, `${numeroFacture}.pdf`, "Voici votre facture. Merci pour votre confiance ! 🙏");

    await sendWhatsappMessage(from, `Votre commande sera livrée sous : ${delaiText}. Merci pour votre confiance ! 🙏`);

    await sendToConfiguredHuman(`📄 Facture ${numeroFacture} envoyée à ${from}. Conversation clôturée.`, from);

    // Nettoyage final de l'état transitoire de ce client — l'adresse a

    // rempli son rôle jusqu'ici (escalade, demande de délai, facture) et

    // n'a plus lieu d'être conservée une fois la commande livrée/facturée.

    const state = getState(from);

    state.deliveryAddress = null;

    state.deliveryMode = null;

    state.pickupMoment = null;

    await persistState(from, state);

    return true;

  } catch (err) {

    log.error("Échec finalisation facture", err);

    await sendToConfiguredHuman(`⚠️ Erreur lors de l'envoi de la facture à ${from} — vérifiez les logs.`, from).catch(() => {});

    return false;

  }

}

export async function provideDeliveryDelay(from, delaiText) {

  const state = getState(from);

  const commandeId = state.awaitingDelaiCommandeId;

  if (!commandeId) {

    log.warn("/delai reçu mais aucun paiement confirmé en attente pour ce numéro", { from });

    await sendToConfiguredHuman(`⚠️ Aucun paiement confirmé en attente pour ${from}. Utilisez d'abord /paiement_recu.`, from).catch(() => {});

    return false;

  }

  state.awaitingDeliveryConfirmation = { commandeId, delaiText, phone: from, createdAt: new Date().toISOString() };

  await persistState(from, state);

  log.info("Délai de livraison reçu, confirmation du numéro demandée avant envoi", { from, commandeId, delaiText });

  await sendWhatsappMessage(

    from,

    `Pour votre livraison, je vais utiliser ce numéro WhatsApp : *+${from}*.\nEst-ce bien le bon numéro ? Répondez simplement *Oui* ou *Non*.`

  );

  return true;

}