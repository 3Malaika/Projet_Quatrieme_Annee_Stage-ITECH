import { Router } from 'express';
import { requireAdmin } from '../middleware/adminAuth.js';
import { config } from '../config/env.js';

const store = config.supabaseUrl
  ? await import('../data/botConfig.store.supabase.js')
  : await import('../data/botConfig.store.js');

const paymentStore = config.supabaseUrl
  ? await import('../data/configTextes.store.supabase.js')
  : await import('../data/paiementCompte.store.js');
const router = Router();

router.get('/status', requireAdmin, async (req, res) => {
  try {
    const botConfig = await store.loadBotConfig();
    const paymentAccounts = await paymentStore.loadPaiementComptes();
    const configured = botConfig.setup?.completed === true;
    res.json({ configured, hasPaymentAccount: paymentAccounts.length > 0, hasEscalationNumber: (botConfig.escalations?.numbers || []).length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur de vérification de la configuration' });
  }
});

router.get('/', requireAdmin, async (req, res) => {
  try { res.json(await store.loadBotConfig()); }
  catch (err) { res.status(500).json({ error: err.message || 'Erreur de lecture de la configuration' }); }
});
router.put('/initial', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const comptes = Array.isArray(body.paymentAccounts) ? body.paymentAccounts : [];
    if (!comptes.length || comptes.some((c) => !c?.numero?.trim())) {
      return res.status(400).json({ error: 'Le numéro de paiement est obligatoire.' });
    }

    const current = await store.loadBotConfig();
    const incoming = body.botConfig && typeof body.botConfig === 'object' ? body.botConfig : body;
    const merged = { ...current, ...incoming, escalations: { ...current.escalations, ...(incoming.escalations || {}) }, parcours: { ...current.parcours, ...(incoming.parcours || {}) } };
    if (!Array.isArray(merged.escalations.numbers) || merged.escalations.numbers.length === 0) {
      return res.status(400).json({ error: 'Au moins un numéro d’escalade est obligatoire.' });
    }
    await store.saveBotConfig(merged);
    await paymentStore.savePaiementComptes(comptes);
    const saved = await store.markInitialSetupComplete();
    res.json({ configured: true, botConfig: saved, paymentAccounts: await paymentStore.loadPaiementComptes() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Configuration initiale invalide' });
  }
});

router.put('/', requireAdmin, async (req, res) => {
  try {
    const value = await store.saveBotConfig(req.body || {});
    res.json(value);
  } catch (err) { res.status(400).json({ error: err.message || 'Configuration invalide' }); }
});
export default router;
