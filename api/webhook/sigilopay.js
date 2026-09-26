// POST /api/webhook/sigilopay: a SigiloPay avisa aqui quando o Pix é pago
const { handler, receberWebhook } = require('../../lib/loja');

module.exports = handler('POST', receberWebhook);
