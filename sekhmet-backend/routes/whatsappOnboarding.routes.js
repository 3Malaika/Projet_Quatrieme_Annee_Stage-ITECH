import { Router } from "express";
import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("whatsapp-onboarding");
const router = Router();

// IMPORTANT : cette version DOIT rester identique à GRAPH_VERSION dans la
// page HTML d'onboarding (public/...).
const GRAPH_VERSION = "v25.0";

// DOIT correspondre EXACTEMENT (slash final inclus) à l'URI présente dans
// Facebook Login for Business > Paramètres > "URI de redirection OAuth
// valides". Bien que la documentation Meta indique que redirect_uri n'est
// "pas requis" pour l'échange d'un code Embedded Signup, ce paramètre
// résout dans la pratique l'erreur trompeuse "Error validating
// verification code... redirect_uri is identical..." (OAuthException 100 /
// sous-code 36008) rencontrée avec le flux FB.login() en popup, où Meta
// semble valider en interne un redirect_uri implicite qu'il faut alors
// repasser explicitement ici pour que ça corresponde.
const REDIRECT_URI = "https://projet-quatrieme-annee-stage-itech.onrender.com/";

// Protégé comme /api/storage/status (voir app.js) : même schéma d'auth par
// ADMIN_TOKEN. Cet endpoint échange le code temporaire renvoyé par
// l'Embedded Signup contre un token d'entreprise permanent auprès de Meta —
// il ne doit JAMAIS être accessible publiquement, sa réponse contient un
// vrai token WhatsApp utilisable pour envoyer des messages.
//
// Le code de l'Embedded Signup expire en 30 secondes : cet appel doit être
// déclenché automatiquement par la page HTML dès qu'elle reçoit le code,
// jamais recopié/collé manuellement.
router.post("/exchange", async (req, res) => {
  const authorized = !config.adminToken || req.headers.authorization === `Bearer ${config.adminToken}`;
  if (!authorized) return res.status(401).json({ error: "Accès refusé" });

  const { code } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Paramètre 'code' manquant ou invalide" });
  }
  if (!config.metaAppId || !config.metaAppSecret) {
    log.error("META_APP_ID / META_APP_SECRET manquant(s) — impossible d'échanger le code");
    return res.status(500).json({ error: "Configuration serveur incomplète (META_APP_ID / META_APP_SECRET)" });
  }

  try {
    const params = new URLSearchParams({
      client_id: config.metaAppId,
      client_secret: config.metaAppSecret,
      code,
      redirect_uri: REDIRECT_URI,
    });
    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${params.toString()}`);
    const data = await response.json();

    if (!response.ok || !data.access_token) {
      log.error("Échec de l'échange du code Embedded Signup auprès de Meta", { status: response.status, data });
      return res.status(502).json({ error: "Échec de l'échange auprès de Meta", details: data?.error || data });
    }

    log.info("Code Embedded Signup échangé avec succès", {
      tokenLength: data.access_token.length,
      tokenType: data.token_type || null,
    });

    // Renvoyé une seule fois pour copie manuelle dans WHATSAPP_TOKEN sur
    // Render. Cet endpoint est protégé par ADMIN_TOKEN et pensé pour un
    // usage ponctuel d'admin (toi), pas pour une exposition publique —
    // ne partage jamais une capture d'écran de cette réponse.
    res.json({ access_token: data.access_token, token_type: data.token_type || null });
  } catch (err) {
    log.error("Erreur lors de l'échange du code Embedded Signup", err);
    res.status(500).json({ error: "Erreur serveur lors de l'échange" });
  }
});

export default router;