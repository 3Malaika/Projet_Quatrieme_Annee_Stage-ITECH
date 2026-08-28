import fs from "fs";

const PAIEMENT_COMPTE_PATH = "./paiement_compte.json";

const DEFAULT_COMPTE = { numero: "", nom: "" };

// Numéro (Mobile Money / Orange Money / MTN MoMo, etc.) et nom du titulaire
// du compte dans lequel les clients doivent envoyer leur paiement. Modifiable
// depuis l'interface admin (page "Compte de paiement"), et transmis par le
// bot au client dès qu'il exprime l'intention de payer.
export function loadPaiementCompte() {
  try {
    const raw = fs.readFileSync(PAIEMENT_COMPTE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { numero: parsed.numero || "", nom: parsed.nom || "" };
  } catch (err) {
    return DEFAULT_COMPTE;
  }
}

export function savePaiementCompte({ numero, nom }) {
  const compte = { numero: numero || "", nom: nom || "" };
  fs.writeFileSync(PAIEMENT_COMPTE_PATH, JSON.stringify(compte, null, 2));
  return compte;
}
