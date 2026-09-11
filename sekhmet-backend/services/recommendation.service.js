import { sendWhatsappImage, sendWhatsappMessage } from "./whatsapp.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("recommendation");

// Nombre maximum de produits envoyés lors d'une recommandation, quel que
// soit le nombre suggéré par le modèle — on tronque toujours à 3 ici, en
// plus de la limite déjà posée côté outil LLM (RECOMMENDATION_TOOL dans
// chat.service.js), pour être certain que la règle est respectée même si
// le modèle ne la suit pas.
export const MAX_RECOMMANDATIONS = 3;

// Envoie UN produit recommandé : photo + légende (nom, prix). Le client
// répond ensuite en texte libre (ex: "je prends 2 du premier et 1
// chouquette") — c'est l'outil "ajout_panier" côté chat.service.js qui
// comprend cette réponse et ajoute directement au panier, sans jamais
// passer par une liste de choix de quantité ("bottom sheet") qui obligeait
// à traiter un seul produit à la fois.
async function sendOneRecommendation(to, produit) {
  const unite = produit.unite ? ` (${produit.unite})` : "";
  const caption = `Voici ce que je vous propose :\n\n*${produit.nom}${unite}*\n💰 ${produit.prix}`;

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
}

export async function sendProductRecommendations(to, produits) {
  const limites = produits.slice(0, MAX_RECOMMANDATIONS);
  log.info("Envoi des recommandations produits", { to, produits: limites.map((p) => p.nom) });

  for (const produit of limites) {
    await sendOneRecommendation(to, produit);
  }

  await sendWhatsappMessage(
    to,
    "Dites-moi ce qui vous intéresse et en quelle quantité (ex : « 2 du premier et 1 savon noir »), et je les ajoute directement à votre panier 😊"
  );
}