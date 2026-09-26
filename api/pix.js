// POST /api/pix: cria a cobrança Pix na SigiloPay
const { handler, criarPix } = require('../lib/loja');

module.exports = handler('POST', criarPix);
