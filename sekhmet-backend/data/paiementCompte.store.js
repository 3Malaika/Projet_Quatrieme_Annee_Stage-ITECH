import fs from "fs";

const PAIEMENT_COMPTE_PATH = "./paiement_compte.json";

const DEFAULT_COMPTES = [];

// Liste de comptes (Mobile Money / Orange Money / MTN MoMo, etc.) — chacun
// avec un numéro et un nom de titulaire — dans lesquels les clients peuvent
// envoyer leur paiement. Modifiable depuis l'interface admin (page "Compte
// de paiement"), et transmise par le bot au client dès qu'il exprime
// l'intention de payer.
//
// Compatibilité ascendante : les installations existantes ont un fichier
// contenant un objet unique { numero, nom } plutôt qu'un tableau. On le
// normalise en tableau d'un seul élément à la lecture.
function normalizeComptes(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .map((c) => ({ numero: c?.numero || "", nom: c?.nom || "" }))
      .filter((c) => c.numero);
  }
  if (parsed && typeof parsed === "object" && parsed.numero) {
    return [{ numero: parsed.numero, nom: parsed.nom || "" }];
  }
  return DEFAULT_COMPTES;
}

export function loadPaiementComptes() {
  try {
    const raw = fs.readFileSync(PAIEMENT_COMPTE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeComptes(parsed);
  } catch (err) {
    return DEFAULT_COMPTES;
  }
}

export function savePaiementComptes(comptes) {
  const normalized = (comptes || [])
    .map((c) => ({ numero: (c.numero || "").trim(), nom: (c.nom || "").trim() }))
    .filter((c) => c.numero);
  fs.writeFileSync(PAIEMENT_COMPTE_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

// --- Compatibilité ascendante ---------------------------------------------
// Anciennes fonctions singulier, conservées pour tout code qui ne serait pas
// encore migré : renvoient/acceptent le premier compte de la liste.
export function loadPaiementCompte() {
  const comptes = loadPaiementComptes();
  return comptes[0] || { numero: "", nom: "" };
}

export function savePaiementCompte({ numero, nom }) {
  const comptes = savePaiementComptes([{ numero, nom }]);
  return comptes[0] || { numero: "", nom: "" };
}
