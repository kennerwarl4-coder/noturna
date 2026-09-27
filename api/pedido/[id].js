// GET /api/pedido/:id: o checkout e a página de obrigado consultam o status aqui
const { handler, statusPedido } = require('../../lib/loja');

module.exports = handler('GET', statusPedido);
