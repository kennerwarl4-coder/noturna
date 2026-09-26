// GET /api/pedido/:id: o checkout pergunta se o pedido já foi pago
const { handler, statusPedido } = require('../../lib/loja');

module.exports = handler('GET', statusPedido);
