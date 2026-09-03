import PDFDocument from "pdfkit";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";

const log = createLogger("invoice");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENTREPRISE = {
  nom: process.env.BUSINESS_NAME || "Sekhmet Shop",
  contact: process.env.BUSINESS_CONTACT || "WhatsApp : +237 620 70 97 32",
  adresse: process.env.BUSINESS_ADDRESS || "",
  devise: process.env.BUSINESS_CURRENCY || "FCFA",
};

const LOGO_PATH = process.env.INVOICE_LOGO_PATH
  ? path.resolve(process.env.INVOICE_LOGO_PATH)
  : path.resolve(__dirname, "../assets/logo.png");

function formatMontant(montant) {
  const n = Math.round(Number(montant) || 0);
  // toLocaleString("fr-FR") insère une espace insécable fine comme séparateur
  // de milliers ; les polices standard de PDFKit (WinAnsi) ne la supportent
  // pas et l'affichent comme "/". On formate donc nous-mêmes avec une
  // espace normale, ce qui rend correctement dans le PDF.
  const formatted = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${formatted} ${ENTREPRISE.devise}`;
}

function formatDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Douala",
  });
}

function parseDetails(commande) {
  let details = [];
  if (Array.isArray(commande?.produits_detail)) details = commande.produits_detail;
  else if (typeof commande?.produits_detail === "string") {
    try { const parsed = JSON.parse(commande.produits_detail); details = Array.isArray(parsed) ? parsed : []; } catch { details = []; }
  }
  const merged = new Map();
  for (const item of details) {
    const key = String(item?.produitId ?? item?.id ?? item?.nom ?? "produit");
    const qty = Number(item?.quantite) || 0;
    const unit = Number(item?.prixUnitaire ?? item?.prix ?? 0) || 0;
    if (!qty) continue;
    if (!merged.has(key)) merged.set(key, { ...item, quantite: qty, prixUnitaire: unit, total: unit * qty });
    else { const current = merged.get(key); current.quantite += qty; current.total = current.quantite * current.prixUnitaire; }
  }
  return [...merged.values()];
}

export function generateNumeroFacture() {
  const date = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Douala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  const yyyymmdd = `${get("year")}${get("month")}${get("day")}`;
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  return `FAC-${yyyymmdd}-${suffix}`;
}

/** Génère une facture PDF professionnelle en mémoire, sans dépendance au stockage cloud. */
export function generateInvoicePdfBuffer(commande) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 45 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const left = 45;
      const right = 550;
      const width = right - left;

      // En-tête avec logo local : fonctionne sur serveur local ou distant.
      if (fs.existsSync(LOGO_PATH)) {
        try { doc.image(LOGO_PATH, left, 38, { fit: [72, 72] }); } catch (e) { log.warn("Logo facture indisponible", e); }
      }
      doc.fillColor("#1a1a1a").fontSize(19).font("Helvetica-Bold")
        .text(ENTREPRISE.nom, left + 88, 42, { width: 250 });
      doc.font("Helvetica").fontSize(9).fillColor("#666666")
        .text(ENTREPRISE.contact, left + 88, 68, { width: 250 });
      if (ENTREPRISE.adresse) doc.text(ENTREPRISE.adresse, left + 88, 82, { width: 250 });

      doc.font("Helvetica-Bold").fontSize(18).fillColor("#1a1a1a")
        .text("FACTURE", 390, 42, { width: 160, align: "right" });
      doc.font("Helvetica").fontSize(9).fillColor("#666666")
        .text(commande.numero_facture || "", 390, 68, { width: 160, align: "right" })
        .text(`Date : ${formatDate(commande.created_at)}`, 390, 83, { width: 160, align: "right" });

      doc.moveTo(left, 125).lineTo(right, 125).strokeColor("#dddddd").stroke();

      // Client — on repart explicitement de la marge gauche sur toute la
      // largeur : sans ça, ce bloc hérite du x=390 laissé par la date en
      // haut à droite et se retrouve coincé dans une colonne étroite.
      doc.x = left;
      doc.y = 145;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#333333")
        .text("FACTURÉ À", left, doc.y, { width });
      doc.moveDown(0.35);
      doc.font("Helvetica").fontSize(10).fillColor("#444444");
      doc.text(commande.nom_client || "Client", left, doc.y, { width });
      if (commande.phone) doc.text(`Téléphone : ${commande.phone}`, left, doc.y, { width });
      doc.moveDown(1.2);

      // Tableau des produits
      const details = parseDetails(commande);
      const rows = details.length ? details : [{
        nom: commande.produits || "Commande",
        quantite: 1,
        prixUnitaire: Number(commande.montant_total) || 0,
        total: Number(commande.montant_total) || 0,
      }];

      const tableTop = doc.y;
      const col = { product: 45, qty: 350, unit: 400, total: 485 };
      doc.rect(left, tableTop, width, 25).fill("#f3f3f3");
      doc.fillColor("#333333").font("Helvetica-Bold").fontSize(9)
        .text("PRODUIT", col.product + 7, tableTop + 8)
        .text("QTÉ", col.qty, tableTop + 8, { width: 35, align: "center" })
        .text("PRIX UNIT.", col.unit, tableTop + 8, { width: 80, align: "right" })
        .text("TOTAL", col.total, tableTop + 8, { width: 60, align: "right" });

      let y = tableTop + 32;
      doc.font("Helvetica").fontSize(9).fillColor("#333333");
      for (const item of rows) {
        const qty = Number(item.quantite) || 0;
        const unit = Number(item.prixUnitaire ?? item.prix ?? 0) || 0;
        const total = Number(item.total ?? unit * qty) || 0;
        const startY = y;
        doc.text(String(item.nom || "Produit"), col.product + 7, y, { width: 285 });
        doc.text(String(qty), col.qty, y, { width: 35, align: "center" });
        doc.text(formatMontant(unit), col.unit, y, { width: 80, align: "right" });
        doc.text(formatMontant(total), col.total, y, { width: 60, align: "right" });
        y = Math.max(startY + 20, doc.y + 5);
        doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor("#eeeeee").stroke();
      }

      doc.y = y + 8;
      const total = Number(commande.montant_total) || 0;
      doc.font("Helvetica").fontSize(10).fillColor("#555555")
        .text("Total", 390, doc.y, { width: 80, align: "right" });
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#1a1a1a")
        .text(formatMontant(total), 475, doc.y - 2, { width: 75, align: "right" });

      // Bloc paiement/livraison — repositionné explicitement à la marge
      // gauche sur toute la largeur (même correctif que le bloc client),
      // dans un encadré pour bien le distinguer du tableau au-dessus.
      const metaTop = doc.y + 20;
      const metaLines = [
        "Paiement : Mobile Money",
        `Statut : ${commande.statut === "facturee" ? "PAYÉ" : String(commande.statut || "À CONFIRMER").toUpperCase()}`,
      ];
      if (commande.adresse_livraison) metaLines.push(`Adresse : ${commande.adresse_livraison}`);
      if (commande.delai_livraison) metaLines.push(`Livraison : ${commande.delai_livraison}`);
      const metaHeight = metaLines.length * 15 + 16;
      doc.rect(left, metaTop, width, metaHeight).fill("#f8f8f8");
      doc.x = left + 12;
      doc.y = metaTop + 10;
      doc.font("Helvetica").fontSize(9).fillColor("#555555");
      for (const line of metaLines) {
        doc.text(line, left + 12, doc.y, { width: width - 24 });
      }

      doc.y = metaTop + metaHeight + 25;
      doc.fontSize(9).fillColor("#888888")
        .text("Merci pour votre confiance.", left, doc.y, { width, align: "center" });
      doc.text(ENTREPRISE.nom, left, doc.y, { width, align: "center" });

      doc.end();
    } catch (err) {
      log.error("Échec génération PDF facture", err);
      reject(err);
    }
  });
}