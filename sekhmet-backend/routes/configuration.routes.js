import { Router } from 'express';
import { requireAdmin } from '../middleware/adminAuth.js';
import { config } from '../config/env.js';

const store = config.supabaseUrl
  ? await import('../data/botConfig.store.supabase.js')
  : await import('../data/botConfig.store.js');
const router = Router();

router.get('/', requireAdmin, async (req, res) => {
  try { res.json(await store.loadBotConfig()); }
  catch (err) { res.status(500).json({ error: err.message || 'Erreur de lecture de la configuration' }); }
});
router.put('/', requireAdmin, async (req, res) => {
  try {
    const value = await store.saveBotConfig(req.body || {});
    res.json(value);
  } catch (err) { res.status(400).json({ error: err.message || 'Configuration invalide' }); }
});
export default router;
