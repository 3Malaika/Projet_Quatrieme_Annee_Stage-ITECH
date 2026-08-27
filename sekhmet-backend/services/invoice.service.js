import PDFDocument from "pdfkit";
import { createLogger } from "../utils/logger.js";

const log = createLogger("invoice");

const ENTREPRISE = {
  nom: "Sekhmet Shop",
  contact: "WhatsApp : +237 620 70 97 32",
  devise: "FCFA",
};

function formatMontant(montant) {
  const n = Number(montant) || 0;
  return `${n.toLocaleString("fr-FR")} ${ENTREPRISE.devise}`;
}

function formatDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
}

// Génère un numéro de facture court et unique, sans dépendre d'une séquence
// SQL dédiée (suffisant pour ce volume de commandes).
export function generateNumeroFacture() {
  const date = new Date();
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = String(Date.now()).slice(-5);
  return `FAC-${yyyymmdd}-${suffix}`;
}

/**
 * Génère le PDF de facture en mémoire (Buffer), pour envoi direct via
 * l'API WhatsApp (upload media) sans avoir besoin d'un hébergement fichier.
 */
export function generateInvoicePdfBuffer(commande) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // En-tête
      doc.fontSize(20).fillColor("#1a1a1a").text(ENTREPRISE.nom, { continued: false });
      doc.fontSize(10).fillColor("#666666").text(ENTREPRISE.contact);
      doc.moveDown(1.5);

      doc.fontSize(16).fillColor("#1a1a1a").text(`Facture ${commande.numero_facture}`);
      doc.fontSize(10).fillColor("#666666").text(`Date : ${formatDate(commande.created_at)}`);
      doc.moveDown(1);

      // Informations client
      doc.fontSize(11).fillColor("#1a1a1a").text("Client", { underline: true });
      doc.fontSize(10).fillColor("#333333");
      if (commande.nom_client) doc.text(`Nom : ${commande.nom_client}`);
      doc.text(`Téléphone : ${commande.phone}`);
      doc.moveDown(1);

      // Détail commande
      doc.fontSize(11).fillColor("#1a1a1a").text("Détail de la commande", { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor("#333333").text(commande.produits, { width: 495 });
      doc.moveDown(1);

      // Total
      doc
        .moveTo(50, doc.y)
        .lineTo(545, doc.y)
        .strokeColor("#dddddd")
        .stroke();
      doc.moveDown(0.5);
      doc
        .fontSize(13)
        .fillColor("#1a1a1a")
        .text(`Total payé : ${formatMontant(commande.montant_total)}`, { align: "right" });
      doc.fontSize(9).fillColor("#666666").text("Mode de paiement : Mobile Money", { align: "right" });
      doc.moveDown(1);

      if (commande.delai_livraison) {
        doc
          .fontSize(10)
          .fillColor("#333333")
          .text(`Délai de livraison estimé : ${commande.delai_livraison}`);
      }

      doc.moveDown(2);
      doc
        .fontSize(9)
        .fillColor("#999999")
        .text("Merci pour votre confiance — Sekhmet Shop", { align: "center" });

      doc.end();
    } catch (err) {
      log.error("Échec génération PDF facture", err);
      reject(err);
    }
  });
}
