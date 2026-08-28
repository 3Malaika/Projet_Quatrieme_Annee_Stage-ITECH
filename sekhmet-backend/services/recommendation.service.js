import { sendWhatsappImage, sendWhatsappMessage, sendWhatsappInteractiveList } from "./whatsapp.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("recommendation");

// Nombre maximum de produits envoyés lors d'une recommandation, quel que
// soit le nombre suggéré par le modèle — on tronque toujours à 3 ici, en
// plus de la limite déjà posée côté outil LLM (RECOMMENDATION_TOOL dans
// chat.service.js), pour être certain que la règle est respectée même si
// le modèle ne la suit pas.
export const MAX_RECOMMANDATIONS = 3;

const QUANTITES_PROPOSEES = [1, 2, 3, 4, 5];

// Encode le produit + la quantité choisie dans l'id de la ligne de liste,
// pour pouvoir tout retrouver quand la réponse (list_reply) arrive dans le
// webhook, sans avoir à conserver un état serveur entre les deux messages.
function buildRowId(produitId, quantite) {
  return `qte::${produitId}::${quantite}`;
}

export function parseQuantiteRowId(rowId) {
  if (!rowId || !rowId.startsWith("qte::")) return null;
  const [, produitId, quantiteStr] = rowId.split("::");
  const quantite = Number(quantiteStr);
  if (!produitId || !Number.isFinite(quantite)) return null;
  return { produitId, quantite };
}

// Envoie UN produit recommandé : photo + légende (nom, prix), puis un
// message interactif "liste" permettant de choisir la quantité et de
// valider le choix — c'est notre remplacement du "panier" WhatsApp natif
// (qui nécessite un catalogue Commerce Manager séparé, non couvert ici).
async function sendOneRecommendation(to, produit) {
  const unite = produit.unite ? ` (${produit.unite})` : "";
  const caption = `*${produit.nom}${unite}*\n💰 ${produit.prix}`;

  if (produit.imageUrl) {
    try {
      await sendWhatsappImage(to, produit.imageUrl, caption);
    } catch (err) {
      log.error("Échec envoi image de la recommandation — repli sur texte", { to, produit: produit.nom, err });
      await sendWhatsappMessage(to, caption);
    }
  } else {
    await sendWhatsappMessage(to, caption);
  }

  const rows = QUANTITES_PROPOSEES.map((q) => ({
    id: buildRowId(produit.id, q),
    title: `${q} unité${q > 1 ? "s" : ""}`,
  }));

  await sendWhatsappInteractiveList(to, {
    body: `Combien de "${produit.nom}" souhaitez-vous commander ?`,
    footer: "Sélectionnez une quantité pour valider votre choix",
    buttonText: "Choisir la quantité",
    sections: [{ title: "Quantité", rows }],
  });
}

// Envoie jusqu'à MAX_RECOMMANDATIONS produits, un par un (photo + liste de
// quantité chacun), dans l'ordre fourni par le modèle.
export async function sendProductRecommendations(to, produits) {
  const limites = produits.slice(0, MAX_RECOMMANDATIONS);
  log.info("Envoi des recommandations produits", { to, produits: limites.map((p) => p.nom) });

  for (const produit of limites) {
    await sendOneRecommendation(to, produit);
  }
}
