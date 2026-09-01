/**
 * Régression documentaire pour la règle de stabilité du nom client.
 * La logique est appliquée dans routes/webhook.routes.js : infos.nom ne peut
 * définir le nom que si clientConnu.nom est encore absent.
 */
function savedName(clientConnu, infos) {
  return clientConnu?.nom || infos.nom || null;
}
function update(clientConnu, infos) {
  return {
    ...(!clientConnu?.nom && infos.nom ? { nom: infos.nom } : {}),
    ...(infos.besoin ? { besoin: infos.besoin } : {}),
  };
}

const first = update(null, { nom: "Babouma", besoin: "produits finis" });
if (first.nom !== "Babouma") throw new Error("Le premier nom doit être enregistré");

const later = update({ nom: "Babouma", besoin: "produits finis" }, {
  nom: "Marie",
  besoin: "je veux des savons",
});
if ("nom" in later) throw new Error("Un nom déjà enregistré ne doit jamais être remplacé automatiquement");
if (later.besoin !== "je veux des savons") throw new Error("Le besoin doit rester actualisable");

console.log("OK — le nom client reste stable tandis que le besoin peut évoluer.");
