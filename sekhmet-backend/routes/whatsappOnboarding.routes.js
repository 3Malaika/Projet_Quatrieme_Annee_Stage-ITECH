import { Router } from "express";
import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("whatsapp-onboarding");
const router = Router();

const GRAPH_VERSION = "v26.0";

router.post("/exchange", async (req, res) => {
  const authorized =
    !config.adminToken ||
    req.headers.authorization === `Bearer ${config.adminToken}`;

  if (!authorized) {
    log.warn("Tentative d'accès non autorisée à /exchange");

    return res.status(401).json({
      error: "Accès refusé"
    });
  }

  const {
    code,
    phone_number_id: phoneNumberId,
    waba_id: wabaId
  } = req.body || {};

  if (!code || typeof code !== "string") {
    return res.status(400).json({
      error: "Paramètre 'code' manquant ou invalide"
    });
  }

  if (phoneNumberId) {
    log.info("Phone Number ID reçu depuis Embedded Signup", {
      phone_number_id: phoneNumberId
    });
  } else {
    log.warn("Aucun phone_number_id reçu depuis le frontend");
  }

  if (wabaId) {
    log.info("WABA ID reçu depuis Embedded Signup", {
      waba_id: wabaId
    });
  } else {
    log.warn("Aucun waba_id reçu depuis le frontend");
  }

  if (!config.metaAppId || !config.metaAppSecret) {
    log.error(
      "META_APP_ID / META_APP_SECRET manquant(s) — impossible d'échanger le code"
    );

    return res.status(500).json({
      error:
        "Configuration serveur incomplète (META_APP_ID / META_APP_SECRET)"
    });
  }

  try {
    const params = new URLSearchParams({
      client_id: config.metaAppId,
      client_secret: config.metaAppSecret,
      code
    });

    log.info("Échange du code Embedded Signup auprès de Meta", {
      graph_version: GRAPH_VERSION,
      has_code: Boolean(code),
      phone_number_id: phoneNumberId || null,
      waba_id: wabaId || null
    });

    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      log.error(
        "Échec de l'échange du code Embedded Signup auprès de Meta",
        {
          status: response.status,
          data
        }
      );

      return res.status(502).json({
        error: "Échec de l'échange auprès de Meta",
        details: data?.error || data
      });
    }

    log.info("Code Embedded Signup échangé avec succès", {
      tokenLength: data.access_token.length,
      tokenType: data.token_type || null,
      phone_number_id: phoneNumberId || null,
      waba_id: wabaId || null
    });

    return res.json({
      access_token: data.access_token,
      token_type: data.token_type || null,
      phone_number_id: phoneNumberId || null,
      waba_id: wabaId || null
    });
  } catch (err) {
    log.error(
      "Erreur lors de l'échange du code Embedded Signup",
      err
    );

    return res.status(500).json({
      error: "Erreur serveur lors de l'échange"
    });
  }
});

export default router;