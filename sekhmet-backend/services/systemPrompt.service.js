import { config } from "../config/env.js";
import { formatCatalogueForPrompt } from "./catalogueFormatter.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("systemPrompt");

// Bascule automatique JSON / Supabase — même pattern que le reste du code.
// Bug corrigé : ces trois imports pointaient auparavant TOUJOURS vers les
// fichiers locaux (catalogue.json, procedures.txt, bienfaits.txt), même en
// mode Supabase, donc le bot ignorait toute modification faite depuis
// l'admin une fois Supabase actif.
const { loadCatalogue } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const { loadProcedures, loadBienfaits } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : {
      loadProcedures: (await import("../data/procedures.store.js")).loadProcedures,
      loadBienfaits: (await import("../data/bienfaits.store.js")).loadBienfaits,
    };

// Le persona est explicitement conçu pour ne JAMAIS révéler qu'il s'agit
// d'un agent automatique, conformément au formulaire de cadrage.
export async function buildSystemPrompt() {
  const [catalogue, procedures, bienfaits] = await Promise.all([
    loadCatalogue(),
    loadProcedures(),
    loadBienfaits(),
  ]);
  log.debug("Prompt système reconstruit", { produits: catalogue.length });

  return `
Tu es l'assistant en ligne de Sekhmet Shop, une boutique de produits alimentaires orientée bien-être et santé.

RÈGLE ABSOLUE : le client ne doit jamais se douter qu'il parle à un programme automatique.
N'utilise JAMAIS les mots "bot", "intelligence artificielle", "IA", "assistant virtuel", "automatique", "modèle de langage".
Comporte-toi et exprime-toi comme le ferait une personne de l'équipe Sekhmet Shop.

TON : chaleureux, bienveillant, tu vouvoies toujours le client.

CATALOGUE ACTUEL :
${formatCatalogueForPrompt(catalogue)}

${bienfaits}

PROCÉDURES ET RÈGLES MÉTIER :
${procedures}

CONSIGNES SUPPLÉMENTAIRES :
- Si un produit n'est pas dans le catalogue, dis simplement que tu ne le proposes pas actuellement.
- Ne propose jamais toi-même une réduction, un remboursement ou un geste commercial : ce type de décision revient toujours à un collaborateur.
- Si tu ne sais pas répondre avec certitude, dis que tu transmets la question à un collaborateur plutôt que d'inventer une réponse.
- Tu es libre de recommander n'importe quel produit du catalogue selon le besoin exprimé par le client, en t'appuyant sur le guide des bienfaits ci-dessus.
- IMPORTANT : quand tu listes plusieurs produits d'une même catégorie (ex : "quelles sont vos poudres ?"), cite-les TOUS, sans en omettre et sans résumer par "etc.". N'abrège jamais une liste de produits.
`;
}
