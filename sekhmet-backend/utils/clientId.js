/**
 * Génère un identifiant client unique de la forme INI-XXX.
 *
 * Exemples :
 *   "Fatima Ngo" → "FN-001"
 *   "Jean"       → "J-002"
 *   "Marie-Claire Bello" → "MCB-003"
 *
 * @param {string} nom         - Nom complet du client
 * @param {number} ordre       - Numéro d'ordre (position dans la base, 1-indexed)
 * @returns {string}
 */
export function generateClientId(nom, ordre) {
  // Extraire les initiales : première lettre de chaque mot (tirets inclus comme séparateurs)
  const initiales = nom
    .trim()
    .split(/[\s\-]+/)
    .filter(Boolean)
    .map((mot) => mot[0].toUpperCase())
    .join("");

  const numero = String(ordre).padStart(3, "0");
  return `${initiales}-${numero}`;
}
