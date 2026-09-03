import { config } from "../config/env.js";
import Groq from "groq-sdk";
import { recordUsage } from "../services/usage.service.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { clearPending, closeEscalationLog, getEscalationsLog } from "../services/escalation.service.js";
import { confirmPayment, rejectPayment, provideDeliveryDelay, findPendingDeliveryClient, getPendingPaymentClients, getPendingDeliveryDetails } from "../services/payment.service.js";
import { createLogger } from "./logger.js";

const log = createLogger("humanCommands");
const groq = config.groqApiKey ? new Groq({ apiKey: config.groqApiKey }) : null;

function normalizeHumanText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/[^0-9+]/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("+")) phone = phone.slice(1);
  return phone;
}

function extractFreeFormPaymentConfirmation(text) {
  const raw = String(text || "").trim();
  const normalized = normalizeHumanText(raw);
  if (!/(recu|reçu|paiement.*recu|paiement.*reçu|encaisse|versement)/i.test(normalized)) return null;

  const phoneCandidates = [...raw.matchAll(/(?:\+|00)?237[\s.-]?[0-9]{8}/g)].map(m => normalizePhone(m[0]));
  const clientNumber = phoneCandidates[0] || null;

  const amountMatch = raw.match(/(?:montant|somme)\s*(?:de|est|:)\s*([0-9][0-9\s.,]{1,12})\s*(?:fcfa|f\s*cfa|xaf)\b/i)
    || raw.match(/\b([0-9][0-9\s.,]{1,12})\s*(?:fcfa|f\s*cfa|xaf)\b/i)
    || raw.match(/\bpour\s+([0-9][0-9\s.,]{1,12})(?:\s+fcfa)?\b/i);
  let montant = null;
  const amountRaw = amountMatch?.[1];
  if (amountRaw) {
    const digits = amountRaw.replace(/[^0-9]/g, "");
    if (digits) montant = Number(digits);
  }

  const accountPatterns = [
    /(?:sur|dans|via|avec)\s+(?:le\s+)?compte(?:\s+mobile\s+money)?\s*[:=]?\s*((?:\+|00)?237[\s.-]?[0-9]{8})/i,
    /(?:numero|n°|no|numéro)\s+(?:du\s+)?compte(?:\s+mobile\s+money)?\s*[:=]?\s*((?:\+|00)?237[\s.-]?[0-9]{8})/i,
    /(?:compte|compte mobile money)\s*[:=]\s*((?:\+|00)?237[\s.-]?[0-9]{8})/i,
  ];
  let numeroCompte = null;
  for (const re of accountPatterns) {
    const m = raw.match(re);
    if (m?.[1]) { numeroCompte = normalizePhone(m[1]); break; }
  }
  // Si plusieurs numéros sont présents, le premier est le client et un autre
  // peut être explicitement le compte Mobile Money. Ne jamais déduire le
  // compte à partir du nom du client.
  if (!numeroCompte && phoneCandidates.length > 1) numeroCompte = phoneCandidates[1];

  // Nom du payeur tel que vu par le collaborateur dans son appli Mobile
  // Money (ex: « reçu de Marie Fotso », « paiement au nom de Paul »). Sert
  // uniquement à retrouver la bonne conversation via matchPendingClient
  // quand aucun numéro client explicite n'est présent — jamais utilisé
  // comme numéro de compte.
  const nameMatch = raw.match(/(?:re[çc]u|paiement|versement)\s+(?:de|par)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,60})/i)
    || raw.match(/(?:au nom de)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,60})/i);
  const payerName = nameMatch?.[1] ? nameMatch[1].trim().replace(/[.!?,;:]+$/, "") : null;

  return { clientNumber, montant, numeroCompte, payerName, raw };
}

// Normalisation légère pour comparer deux noms malgré accents/casse/espaces.
function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rattache une confirmation de paiement du collaborateur (numéro client
 * explicite, sinon nom du payeur et/ou montant) à LA conversation en
 * attente correspondante, quand plusieurs clients ont un paiement en
 * cours de vérification en même temps.
 *
 * Priorité : numéro client explicite > (nom + montant) simultanément
 * uniques > montant seul unique > nom seul unique. Si plusieurs candidats
 * restent possibles ou qu'aucun ne correspond, on ne devine pas : on
 * retourne les candidats pour que le collaborateur tranche.
 */
function matchPendingClient(pending, { clientNumber, montant, payerName, numeroCompte } = {}) {
  const list = Array.isArray(pending) ? pending : [];

  if (clientNumber) {
    const exact = list.find((p) => normalizeExtractedPhone(p.phone) === normalizeExtractedPhone(clientNumber));
    return { target: exact ? normalizeExtractedPhone(exact.phone) : normalizeExtractedPhone(clientNumber), candidates: [] };
  }

  const byAmount = Number.isFinite(montant) && montant > 0
    ? list.filter((p) => Number(p.total) === Number(montant))
    : list;
  const normalizedPayerName = payerName ? normalizeName(payerName) : null;
  const byName = normalizedPayerName
    ? list.filter((p) => {
        const declared = normalizeName(p.compteMobileMoney);
        return declared && (declared === normalizedPayerName || declared.includes(normalizedPayerName) || normalizedPayerName.includes(declared));
      })
    : list;
  const byAccountNumber = numeroCompte
    ? list.filter((p) => normalizeExtractedPhone(p.numeroCompteMobileMoney) === normalizeExtractedPhone(numeroCompte))
    : list;

  // Intersection des critères réellement fournis (on ignore un critère
  // absent plutôt que de le traiter comme "tout le monde correspond").
  const filters = [
    Number.isFinite(montant) && montant > 0 ? byAmount : null,
    normalizedPayerName ? byName : null,
    numeroCompte ? byAccountNumber : null,
  ].filter(Boolean);

  if (!filters.length) return { target: null, candidates: [] };

  const intersection = filters.reduce((acc, arr) => acc.filter((p) => arr.some((q) => q.phone === p.phone)), filters[0]);

  if (intersection.length === 1) return { target: normalizeExtractedPhone(intersection[0].phone), candidates: [] };
  if (intersection.length > 1) return { target: null, candidates: intersection };

  // Aucune intersection stricte (ex: le nom déclaré diffère légèrement de
  // celui vu par le collaborateur) : retente avec le montant seul, qui est
  // le critère le plus fiable quand il est unique.
  if (Number.isFinite(montant) && montant > 0 && byAmount.length === 1) {
    return { target: normalizeExtractedPhone(byAmount[0].phone), candidates: [] };
  }
  if (Number.isFinite(montant) && montant > 0 && byAmount.length > 1) {
    return { target: null, candidates: byAmount };
  }
  return { target: null, candidates: [] };
}

function formatCandidatesList(candidates) {
  return candidates
    .map((p) => `- ${p.phone}${p.compteMobileMoney ? ` (${p.compteMobileMoney})` : ""}${Number.isFinite(p.total) ? ` — ${p.total} FCFA` : ""}`)
    .join("\n");
}

/**
 * Même principe que matchPendingClient, mais pour rattacher un délai de
 * livraison annoncé en langage naturel (« peut-être 1 heure ») à LA
 * commande en attente correspondante — en confrontant ce que dit le
 * collaborateur (numéro client, montant, nom de compte) aux commandes
 * réellement en attente d'un délai (produits, montant, compte). S'il y a
 * plusieurs commandes en attente et qu'aucun critère ne permet de trancher,
 * on ne devine jamais : on liste les candidats pour que le collaborateur
 * confirme explicitement laquelle est concernée avant qu'on écrive au client.
 */
function matchPendingDeliveryClient(deliveryPending, { clientNumber, montant, payerName } = {}) {
  const list = Array.isArray(deliveryPending) ? deliveryPending : [];

  if (clientNumber) {
    const exact = list.find((p) => normalizeExtractedPhone(p.phone) === normalizeExtractedPhone(clientNumber));
    return { target: exact ? normalizeExtractedPhone(exact.phone) : null, candidates: [] };
  }

  if (list.length === 0) return { target: null, candidates: [] };
  if (list.length === 1) return { target: normalizeExtractedPhone(list[0].phone), candidates: [] };

  const normalizedPayerName = payerName ? normalizeName(payerName) : null;
  const byAmount = Number.isFinite(montant) && montant > 0 ? list.filter((p) => Number(p.montant) === Number(montant)) : list;
  const byName = normalizedPayerName
    ? list.filter((p) => {
        const declared = normalizeName(p.compteMobileMoney);
        return declared && (declared === normalizedPayerName || declared.includes(normalizedPayerName) || normalizedPayerName.includes(declared));
      })
    : list;

  const filters = [
    Number.isFinite(montant) && montant > 0 ? byAmount : null,
    normalizedPayerName ? byName : null,
  ].filter(Boolean);

  if (!filters.length) return { target: null, candidates: list };

  const intersection = filters.reduce((acc, arr) => acc.filter((p) => arr.some((q) => q.phone === p.phone)), filters[0]);
  if (intersection.length === 1) return { target: normalizeExtractedPhone(intersection[0].phone), candidates: [] };
  return { target: null, candidates: intersection.length ? intersection : list };
}

function formatDeliveryCandidatesList(candidates) {
  return candidates
    .map((p) => `- ${p.phone}${p.produits ? ` : ${p.produits}` : ""}${Number.isFinite(p.montant) ? ` — ${p.montant} FCFA` : ""}${p.compteMobileMoney ? ` (payé par ${p.compteMobileMoney})` : ""}`)
    .join("\n");
}
async function interpretHumanMessageWithGroq(text, pending, deliveryPending) {
  if (!groq) return null;
  const context = (pending || []).slice(0, 8).map((p) => ({
    client: p.phone,
    expectedAmount: Number.isFinite(p.total) ? p.total : null,
    payerNameDeclaredByClient: p.compteMobileMoney || null,
    clientAccountNumber: p.numeroCompteMobileMoney || null,
    clientMessage: String(p.userMessage || "").slice(0, 500),
  }));
  const deliveryContext = (deliveryPending || []).slice(0, 8).map((p) => ({
    client: p.phone,
    produits: p.produits || null,
    montant: Number.isFinite(p.montant) ? p.montant : null,
    payerNameDeclaredByClient: p.compteMobileMoney || null,
  }));
  const escalations = await getEscalationsLog().catch(() => []);
  const escalationContext = (Array.isArray(escalations) ? escalations : [])
    .filter((e) => e?.status === "en_attente")
    .slice(-8)
    .map((e) => ({
      client: e.from,
      request: String(e.userMessage || "").slice(0, 500),
      summary: String(e.agentMessage || "").slice(0, 900),
    }));
  const system = `Tu es le moteur de compréhension des messages d'un collaborateur WhatsApp de Sekhmet Shop.
Tu dois comprendre le français naturel, les fautes, les abréviations, les tournures camerounaises et les phrases elliptiques.
Tu NE dois JAMAIS inventer un numéro, un montant ou un nom de compte.
Tu ne déclenches aucune action toi-même : tu extrais uniquement l'intention et les informations présentes.
Retourne UNIQUEMENT un JSON valide, sans markdown, avec exactement :
{"intent":"payment_received|payment_refused|delivery_delay|close_escalation|account_number|general","client_number":null,"amount":null,"account_number":null,"payer_name":null,"reason":null,"delay":null,"order_description":null,"reply":null}
- payment_received = le collaborateur dit que l'argent est bien reçu/encaissé.
- payment_refused = paiement non reçu/refusé.
- delivery_delay = il donne ou demande un délai de livraison.
- close_escalation = il indique que la demande est résolue/terminée.
- account_number = il donne le numéro du compte Mobile Money ayant reçu le paiement.
- general = toute autre conversation; dans ce cas reply doit être une réponse naturelle et utile.
Pour payment_received, extrais le numéro client, le montant et le numéro du compte Mobile Money uniquement s'ils sont réellement présents. Le nom du client ne doit jamais être utilisé comme numéro de compte.
payer_name = le nom du payeur tel que vu par le collaborateur (ex: dans son appli Mobile Money), s'il le mentionne — ex: "reçu 5000 de Marie Fotso" -> payer_name="Marie Fotso". Laisse null s'il n'est pas mentionné.
order_description = si le collaborateur mentionne les produits et quantités commandés par le client dans son message (ex: "2 sacs de farine de patate, 1 savon noir"), restitue cette description telle quelle en langage naturel ("2 x Farine de patate, 1 x Savon noir"). Laisse null s'il ne mentionne aucun produit — ne déduis et n'invente jamais de produit non mentionné.
IMPORTANT pour client_number : le collaborateur ne connaît presque jamais le numéro WhatsApp du client — il voit seulement un NOM et un MONTANT dans son appli Mobile Money. Le "contexte des paiements en attente" ci-dessous liste, pour chaque client qui a un paiement en vérification, le numéro WhatsApp (client), le montant attendu (expectedAmount), le nom de compte déclaré par le client lui-même (payerNameDeclaredByClient) et son numéro de compte (clientAccountNumber).
Si le collaborateur ne donne PAS explicitement le numéro WhatsApp du client, essaie de déduire client_number en comparant amount/payer_name/account_number à ce contexte :
- si un seul élément du contexte correspond au montant ET/OU au nom mentionnés, renvoie son "client" comme client_number ;
- si plusieurs éléments correspondent également (ambiguïté réelle) OU si rien ne correspond, laisse client_number=null — ne devine jamais au hasard.
Si le message dit seulement « c'est reçu » sans aucun montant ni nom, utilise le contexte pour identifier le client seulement s'il n'y en a qu'un en attente ; sinon client_number=null.
Pour delivery_delay (le collaborateur donne un délai de livraison, ex: "peut-être 1 heure", "2 jours"), le "contexte des commandes en attente d'un délai de livraison" ci-dessous liste chaque commande déjà payée qui attend encore ce délai (produits, montant, nom du payeur). Le collaborateur ne précise presque jamais le numéro du client à ce stade non plus : déduis client_number de la même façon (montant/produits/nom mentionnés comparés à ce contexte), et laisse client_number=null s'il y a plusieurs commandes en attente et qu'aucun détail ne permet de trancher — ne devine jamais au hasard, surtout ici où une erreur enverrait la facture au mauvais client.
Contexte des paiements en attente : ${JSON.stringify(context)}
Contexte des commandes en attente d'un délai de livraison : ${JSON.stringify(deliveryContext)}
Contexte des escalades actuellement en attente : ${JSON.stringify(escalationContext)}`;
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      max_tokens: 260,
      reasoning_effort: "low",
      messages: [{ role: "system", content: system }, { role: "user", content: String(text).slice(0, 1200) }],
      response_format: { type: "json_object" },
    });
    await recordUsage({ type: "comprehension_collaborateur", model: "openai/gpt-oss-120b", usage: response.usage });
    return JSON.parse(response.choices?.[0]?.message?.content || "{}");
  } catch (err) {
    log.error("Échec de compréhension Groq du collaborateur", { error: err?.message || String(err) });
    return null;
  }
}

function normalizeExtractedPhone(value) {
  const n = normalizePhone(value);
  if (!/^237[0-9]{9}$/.test(n)) return null;
  return n;
}

// senderNumber est toujours fourni explicitement par webhook.routes.js (le
// numéro exact de l'agent qui vient d'écrire, tel qu'identifié via
// isHumanAgentNumber -> la configuration GUI). Aucune valeur par défaut
// basée sur une variable d'environnement : avec plusieurs agents possibles,
// un seul numéro "par défaut" n'aurait pas de sens.
export async function handleHumanCommand(text, senderNumber) {
  if (!senderNumber) {
    log.error("handleHumanCommand appelée sans senderNumber — message ignoré");
    return;
  }
  const trimmed = text.trim();

  const parts = trimmed.split(" ");
  const command = parts[0];

  // Les réponses naturelles du collaborateur sont traitées AVANT le flux
  // des commandes slash. Sinon un message comme « j'ai reçu le paiement... »
  // était rejeté immédiatement et le parseur naturel n'était jamais atteint.
  if (!trimmed.startsWith("/")) {
    const pending = getPendingPaymentClients();
    const deliveryPending = await getPendingDeliveryDetails();
    const ai = await interpretHumanMessageWithGroq(trimmed, pending, deliveryPending);

    if (ai) {
      const intent = String(ai.intent || "general");
      const clientNumber = normalizeExtractedPhone(ai.client_number);
      const montant = Number(ai.amount);
      const numeroCompte = normalizeExtractedPhone(ai.account_number);
      const orderDescription = ai.order_description ? String(ai.order_description).trim() : undefined;
      const payerName = ai.payer_name ? String(ai.payer_name).trim() : null;

      if (intent === "payment_received") {
        let target = clientNumber;
        let candidates = [];
        if (!target) {
          // L'IA n'a pas pu déduire le numéro WhatsApp directement : on
          // retente une résolution déterministe à partir du nom du payeur
          // et/ou du montant que le collaborateur a donnés, comparés au
          // contexte des paiements en attente (voir matchPendingClient).
          const resolved = matchPendingClient(pending, { montant, payerName, numeroCompte });
          target = resolved.target;
          candidates = resolved.candidates;
        }
        if (!target) {
          if (candidates.length > 1) {
            await sendWhatsappMessage(senderNumber, `Plusieurs clients en attente correspondent. Duquel s'agit-il ?\n${formatCandidatesList(candidates)}\n\nRépondez avec le numéro du bon client.`);
          } else {
            await sendWhatsappMessage(senderNumber, pending.length > 1
              ? "J'ai bien compris que le paiement est reçu, mais je n'arrive pas à identifier le client avec le nom/montant donnés. Quel est son numéro WhatsApp ?"
              : "J'ai bien compris que le paiement est reçu. Quel est le numéro WhatsApp du client concerné ?");
          }
          return;
        }
        if (!Number.isFinite(montant) || montant <= 0) {
          const expected = pending.find((p) => normalizeExtractedPhone(p.phone) === target)?.total;
          await sendWhatsappMessage(senderNumber, expected ? `J'ai identifié le client ${target}. Quel montant avez-vous reçu ? (Le montant attendu est ${expected} FCFA.)` : "Quel montant avez-vous reçu, en FCFA ?");
          return;
        }
        if (!numeroCompte) {
          await sendWhatsappMessage(senderNumber, `Paiement de ${target} pour ${montant} FCFA bien identifié. Quel est le numéro du compte Mobile Money sur lequel le paiement a été reçu ?`);
          return;
        }
        try {
          await confirmPayment(target, montant, orderDescription, numeroCompte);
          await sendWhatsappMessage(senderNumber, `Parfait. Paiement confirmé pour ${target} : ${montant} FCFA, compte Mobile Money ${numeroCompte}. La commande est enregistrée.`);
        } catch (err) {
          log.error("Échec confirmation paiement comprise par Groq", { target, montant, numeroCompte, err });
          if (/aucune description de produits/i.test(err.message)) {
            await sendWhatsappMessage(senderNumber, `Paiement de ${target} pour ${montant} FCFA bien identifié, mais je n'ai aucune commande en attente pour ce client. Quels produits et quantités a-t-il commandés ?`);
          } else {
            await sendWhatsappMessage(senderNumber, `Je ne finalise pas encore la commande : ${err.message}`);
          }
        }
        return;
      }

      if (intent === "account_number") {
        if (pending.length === 1 && numeroCompte) {
          try {
            await confirmPayment(normalizeExtractedPhone(pending[0].phone), undefined, orderDescription, numeroCompte);
            await sendWhatsappMessage(senderNumber, `Merci. Le compte Mobile Money ${numeroCompte} est enregistré et le paiement est confirmé pour ${pending[0].phone}.`);
          } catch (err) {
            if (/aucune description de produits/i.test(err.message)) {
              await sendWhatsappMessage(senderNumber, `Le compte est bien noté, mais je n'ai aucune commande en attente pour ${pending[0].phone}. Quels produits et quantités a-t-il commandés ?`);
            } else {
              await sendWhatsappMessage(senderNumber, `Je ne finalise pas encore la commande : ${err.message}`);
            }
          }
          return;
        }
      }

      if (intent === "payment_refused" && clientNumber) {
        await rejectPayment(clientNumber, ai.reason ? String(ai.reason) : null);
        return;
      }

      if (intent === "delivery_delay" && ai.delay) {
        let deliveryTarget = clientNumber;
        let deliveryCandidates = [];
        if (!deliveryTarget) {
          const resolved = matchPendingDeliveryClient(deliveryPending, { montant, payerName });
          deliveryTarget = resolved.target;
          deliveryCandidates = resolved.candidates;
        }
        if (!deliveryTarget) {
          if (!deliveryPending.length) {
            await sendWhatsappMessage(senderNumber, "Je n'ai aucune commande en attente d'un délai de livraison pour le moment.");
          } else if (deliveryCandidates.length) {
            await sendWhatsappMessage(senderNumber, `Plusieurs commandes attendent un délai de livraison. Laquelle est concernée ?\n${formatDeliveryCandidatesList(deliveryCandidates)}\n\nRépondez avec le numéro du bon client.`);
          } else {
            await sendWhatsappMessage(senderNumber, "Pour quel client est ce délai ? Précisez son numéro WhatsApp.");
          }
          return;
        }
        await provideDeliveryDelay(deliveryTarget, String(ai.delay));
        await sendWhatsappMessage(senderNumber, `C'est noté : délai de ${ai.delay} transmis à ${deliveryTarget}.`);
        return;
      }

      if (intent === "close_escalation" && clientNumber) {
        clearPending(clientNumber);
        await closeEscalationLog(clientNumber);
        await sendWhatsappMessage(senderNumber, `C'est noté, l'escalade de ${clientNumber} est clôturée.`);
        return;
      }

      if (intent === "general" && ai.reply) {
        await sendWhatsappMessage(senderNumber, String(ai.reply).slice(0, 1800));
        return;
      }
    }

    // Filet de sécurité uniquement si Groq est indisponible ou n'a pas pu comprendre.
    const confirmation = extractFreeFormPaymentConfirmation(trimmed);
    if (confirmation) {
      const { montant, numeroCompte, payerName } = confirmation;
      let { clientNumber } = confirmation;
      let candidates = [];
      if (!clientNumber) {
        const resolved = matchPendingClient(pending, { montant, payerName, numeroCompte });
        clientNumber = resolved.target;
        candidates = resolved.candidates;
      }
      if (!clientNumber) {
        await sendWhatsappMessage(senderNumber, candidates.length > 1
          ? `Plusieurs clients en attente correspondent. Duquel s'agit-il ?\n${formatCandidatesList(candidates)}\n\nRépondez avec le numéro du bon client.`
          : "Quel est le numéro du client concerné ?");
        return;
      }
      if (!montant || !Number.isFinite(montant) || montant <= 0) { await sendWhatsappMessage(senderNumber, `Quel montant avez-vous reçu pour ${clientNumber} ?`); return; }
      if (!numeroCompte) { await sendWhatsappMessage(senderNumber, `Quel est le numéro du compte Mobile Money ayant reçu le paiement de ${clientNumber} ?`); return; }
      try { await confirmPayment(clientNumber, montant, undefined, numeroCompte); await sendWhatsappMessage(senderNumber, `Paiement confirmé pour ${clientNumber}.`); }
      catch (err) {
        if (/aucune description de produits/i.test(err.message)) {
          await sendWhatsappMessage(senderNumber, `Paiement de ${clientNumber} bien identifié, mais je n'ai aucune commande en attente pour ce client. Quels produits et quantités a-t-il commandés ?`);
        } else {
          await sendWhatsappMessage(senderNumber, `Je ne finalise pas encore la commande : ${err.message}`);
        }
      }
      return;
    }

    await sendWhatsappMessage(senderNumber, "Je vous écoute. Dites-moi simplement ce que vous avez constaté ou ce que vous souhaitez faire pour le client.");
    return;
  }

  log.info("Commande reçue", { command });

  if (command === "/resolu") {
    const clientNumber = parts[1];
    clearPending(clientNumber);
    await closeEscalationLog(clientNumber);
    await sendWhatsappMessage(senderNumber, `✅ Escalade clôturée pour ${clientNumber}.`);
    log.info("Escalade clôturée via /resolu", { clientNumber });
    return;
  }

  if (command === "/repondre") {
    const clientNumber = parts[1];
    const messageToClient = parts.slice(2).join(" ");
    if (!messageToClient) {
      log.warn("/repondre appelée sans message", { clientNumber });
      await sendWhatsappMessage(senderNumber, "Format: /repondre <numero> <message>");
      return;
    }
    await sendWhatsappMessage(clientNumber, messageToClient);
    clearPending(clientNumber);
    await closeEscalationLog(clientNumber);
    await sendWhatsappMessage(senderNumber, `✅ Message envoyé à ${clientNumber}, escalade clôturée.`);
    log.info("Réponse manuelle envoyée via /repondre", { clientNumber });
    return;
  }

  // Confirmation EXPLICITE que le paiement a été reçu — rien ne se passe
  // (pas de commande, pas de facture) tant que cette commande n'a pas été
  // envoyée par le collaborateur.
  //
  // La description des produits est désormais OPTIONNELLE : si le client a
  // choisi une/des quantité(s) via la liste interactive WhatsApp, ce choix
  // est automatiquement récupéré et persisté dans la commande (voir
  // confirmPayment() dans payment.service.js). On ne l'exige donc que si
  // aucune sélection n'est en attente pour ce client (confirmPayment lève
  // alors une erreur explicite, remontée au collaborateur ci-dessous).
  if (command === "/paiement_recu") {
    const clientNumber = parts[1];
    const montant = parts[2] ? Number(parts[2]) : undefined;
    const rawAfterAmount = parts.slice(montant !== undefined ? 3 : 2).join(" ");
    // Avec la commande explicite, le dernier argument peut être le nom du compte.
    // On retire « compte: ... » de la description des produits pour ne jamais
    // enregistrer ce texte comme produit.
    const compteMatch = rawAfterAmount.match(/(?:^|\s)(?:compte|numero du compte|numéro du compte|compte mobile money)\s*[:=]?\s*((?:\+|00)?237[\s.-]?[0-9]{8})$/i);
    const numeroCompte = compteMatch?.[1] ? normalizeExtractedPhone(compteMatch[1]) : null;
    const produitsDescription = (compteMatch ? rawAfterAmount.slice(0, compteMatch.index).trim() : rawAfterAmount).trim() || undefined;
    if (!clientNumber || (montant !== undefined && (!Number.isFinite(montant) || montant <= 0))) {
      log.warn("/paiement_recu appelée avec un format invalide", { clientNumber, montant });
      await sendWhatsappMessage(
        senderNumber,
        "Format: /paiement_recu <numero> [montant] [description des produits] compte: <numero du compte Mobile Money>\n(Le numéro du compte Mobile Money est obligatoire avant la création de la commande.)"
      );
      return;
    }
    try {
      await confirmPayment(clientNumber, montant, produitsDescription, numeroCompte);
    } catch (err) {
      log.error("Échec /paiement_recu", { clientNumber, err });
      await sendWhatsappMessage(
        senderNumber,
        `⚠️ ${err.message}\nFormat: /paiement_recu <numero> [montant] <description des produits>`
      );
    }
    return;
  }

  // Le paiement n'a PAS été reçu : le bot prévient le client, rien n'est
  // facturé.
  if (command === "/paiement_refuse") {
    const clientNumber = parts[1];
    const raison = parts.slice(2).join(" ") || null;
    if (!clientNumber) {
      log.warn("/paiement_refuse appelée sans numéro");
      await sendWhatsappMessage(senderNumber, "Format: /paiement_refuse <numero> [raison]");
      return;
    }
    await rejectPayment(clientNumber, raison);
    return;
  }

  // Délai de livraison pour UN client précis (obligatoire de préciser le
  // numéro : plusieurs paiements peuvent être en cours de vérification en
  // même temps, un texte libre sans numéro serait ambigu).
  if (command === "/delai") {
    const candidate = parts[1] || "";
    const looksLikePhone = /^(?:\+|00)?[0-9]{8,15}$/.test(candidate.replace(/[^0-9+]/g, ""));
    const clientNumber = looksLikePhone ? candidate.replace(/[^0-9+]/g, "") : findPendingDeliveryClient();
    const delaiText = looksLikePhone ? parts.slice(2).join(" ") : parts.slice(1).join(" ");
    if (!clientNumber || !delaiText) {
      log.warn("/delai appelée sans cible déterminable", { clientNumber, delaiText });
      await sendWhatsappMessage(senderNumber, clientNumber
        ? "Format: /delai <texte>"
        : "Plusieurs livraisons sont en attente. Utilisez /delai <numero> <texte> pour préciser le client.");
      return;
    }
    await provideDeliveryDelay(clientNumber, delaiText);
    return;
  }
  if (command === "/aide") {
    await sendWhatsappMessage(
      senderNumber,
      "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>\n/paiement_recu <numero> [montant] [description produits] compte: <numero du compte Mobile Money>\n/paiement_refuse <numero> [raison]\n/delai <texte> (si un seul paiement attend le délai) ou /delai <numero> <texte>"
    );
    return;
  }

  log.warn("Commande inconnue reçue du collaborateur", { command });
  await sendWhatsappMessage(
    senderNumber,
    "Commande non reconnue. Envoyez /aide pour voir la liste des commandes disponibles."
  );
}