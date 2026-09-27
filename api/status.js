// GET /api/status: diagnóstico da configuração (só diz o que falta, nunca mostra chaves)
const { config, WEBHOOK_PATH } = require('../lib/loja');

module.exports = (req, res) => {
  const { publicKey, secretKey, publicUrl } = config();
  const pronto = Boolean(publicKey && secretKey && publicUrl);
  res.statusCode = pronto ? 200 : 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    pronto,
    chavePublicaSigiloPay: publicKey ? 'ok' : 'FALTANDO (SIGILOPAY_PUBLIC_KEY)',
    chaveSecretaSigiloPay: secretKey ? 'ok' : 'FALTANDO (SIGILOPAY_SECRET_KEY)',
    webhook: publicUrl ? publicUrl + WEBHOOK_PATH : 'FALTANDO (PUBLIC_URL)',
    regiao: process.env.VERCEL_REGION || 'local',
  }, null, 2));
};
