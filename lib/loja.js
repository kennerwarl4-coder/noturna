/*
 * Regras da loja + integração Pix SigiloPay
 * ------------------------------------------------------------------
 * Fluxo (o recomendado pela documentação da SigiloPay):
 *   1. POST /api/pix           cria UMA cobrança por pedido (idempotente)
 *   2. SigiloPay → webhook     marca o pedido como PAGO no armazenamento
 *   3. GET /api/pedido/:id     o checkout consulta o NOSSO servidor até ficar PAGO
 *                              (consultar a SigiloPay em loop é bloqueado por ela)
 *
 * Usado pelas funções da Vercel (api/) e pelo servidor local (server.js).
 */
'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const store = require('./store');

const SIGILOPAY_API = 'https://app.sigilopay.com.br/api/v1';
const WEBHOOK_PATH = '/api/webhook/sigilopay';
const ID_PEDIDO = /^NOT-[A-F0-9]{16}$/; // gerado no checkout, 64 bits aleatórios

// ------------------------------------------------------------------
// Catálogo: o preço é definido aqui, nunca pelo navegador
// ------------------------------------------------------------------
const PRODUTO = { id: 'kit-ritual-da-noite', nome: 'Kit Ritual da Noite', precoCentavos: 4790 };
const DESCONTO_PIX = 0.05;
const QTD_MAX = 10;

function calcularTotal(qtd) {
  const subtotal = PRODUTO.precoCentavos * qtd;
  const total = Math.round(subtotal * (1 - DESCONTO_PIX)); // R$ 47,90 → R$ 45,51
  return { subtotal, desconto: subtotal - total, total };
}

// ------------------------------------------------------------------
// Configuração (na Vercel vem das Environment Variables)
// ------------------------------------------------------------------
function config() {
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const publicUrl = (process.env.PUBLIC_URL || (vercelUrl ? 'https://' + vercelUrl : '')).trim().replace(/\/+$/, '');
  return {
    publicKey: process.env.SIGILOPAY_PUBLIC_KEY || '',
    secretKey: process.env.SIGILOPAY_SECRET_KEY || '',
    publicUrl,
  };
}

// ------------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const digits = (s) => String(s || '').replace(/\D/g, '');

function igualSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function cpfValido(v) {
  const c = digits(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((10 * s) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

function ipDe(req) {
  const h = req.headers || {};
  if (process.env.VERCEL || process.env.TRUST_PROXY === '1') {
    return String(h['x-real-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

async function qrCodeDe(codigoPix) {
  return QRCode.toDataURL(codigoPix, { margin: 1, width: 480, color: { dark: '#222222', light: '#FFFFFF' } });
}

// Resposta pública de um pedido (sem CPF, e-mail, endereço ou token)
async function visaoPublica(p) {
  const base = {
    pedido: p.id,
    status: p.status,
    qtd: p.qtd,
    total: p.valores.total / 100,
    primeiroNome: p.cliente.nome.split(/\s+/)[0],
  };
  if (p.status === 'PENDENTE' && p.pix) {
    base.pix = { copiaECola: p.pix.code, qrCode: await qrCodeDe(p.pix.code), expiraEm: p.pix.expiraEm };
  }
  return base;
}

// ------------------------------------------------------------------
// POST /api/pix: cria (ou devolve) a cobrança do pedido
// ------------------------------------------------------------------
function validarPedido(body) {
  const c = body.cliente || {};
  const e = body.entrega || {};
  const qtd = Number(body.qtd);
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > QTD_MAX) return 'Quantidade inválida.';
  if (typeof c.nome !== 'string' || c.nome.trim().split(/\s+/).length < 2 || c.nome.length > 150) return 'Digite nome e sobrenome.';
  if (typeof c.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim()) || c.email.length > 254) return 'E-mail inválido.';
  if (![10, 11].includes(digits(c.whats).length)) return 'WhatsApp inválido.';
  if (!cpfValido(c.cpf)) return 'CPF inválido.';
  if (digits(e.cep).length !== 8) return 'CEP inválido.';
  for (const campo of ['rua', 'numero', 'bairro', 'cidade']) {
    if (typeof e[campo] !== 'string' || !e[campo].trim() || e[campo].length > 200) return 'Endereço incompleto.';
  }
  if (e.comp != null && (typeof e.comp !== 'string' || e.comp.length > 200)) return 'Complemento inválido.';
  if (!/^[A-Z]{2}$/.test(String(e.uf || ''))) return 'Estado inválido.';
  return '';
}

// Erros da SigiloPay → mensagem para a cliente (o detalhe técnico vai para o log)
function mensagemDeErro(status, data, texto) {
  const codigo = (data && (data.errorCode || (data.error && data.error.code))) || '';
  if (status === 403 && /<html/i.test(texto)) {
    console.error('[sigilopay] Bloqueio por localização: a função precisa rodar no Brasil, EUA ou Portugal.');
  }
  if (status === 401 || codigo === 'GATEWAY_UNAUTHORIZED' || codigo === 'GATEWAY_INVALID_CREDENTIALS') {
    console.error('[sigilopay] Chaves recusadas: confira SIGILOPAY_PUBLIC_KEY e SIGILOPAY_SECRET_KEY.');
  }
  if (codigo === 'TOO_MANY_REQUESTS' || status === 429) return 'Muitos pedidos aguardando pagamento agora. Tente de novo em alguns minutos.';
  if (codigo === 'GATEWAY_INVALID_ARGUMENT' || codigo === 'GATEWAY_INVALID_DATA' || status === 400 || status === 422) {
    return 'Algum dado não foi aceito pelo banco. Confira nome, e-mail, WhatsApp e CPF.';
  }
  return 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.';
}

// Erro em que a cobrança certamente NÃO ficou pendente na SigiloPay:
// o checkout deve usar um número de pedido novo na próxima tentativa.
const erroComNovoPedido = (status, erro) => ({ status, body: { erro, novoPedido: true } });

async function criarPix({ body, ip }) {
  const { publicKey, secretKey, publicUrl } = config();
  if (!publicKey || !secretKey || !publicUrl) {
    console.error('[config] Defina SIGILOPAY_PUBLIC_KEY, SIGILOPAY_SECRET_KEY e PUBLIC_URL.');
    return { status: 503, body: { erro: 'Pagamento indisponível no momento.' } };
  }
  if (!body || typeof body !== 'object' || !ID_PEDIDO.test(String(body.pedido || ''))) {
    return erroComNovoPedido(400, 'Pedido inválido. Recarregue a página e tente de novo.');
  }
  const id = body.pedido;

  // Trava: dois cliques/requisições simultâneas do mesmo pedido não criam duas cobranças
  if (!(await store.travar(id, 30))) {
    return { status: 409, body: { erro: 'Seu Pix já está sendo gerado. Aguarde um instante.' } };
  }
  try {
    // Idempotência: pedido já tem cobrança → devolve a mesma, sem chamar a SigiloPay
    const existente = await store.buscarPedido(id);
    if (existente) {
      if (existente.status === 'PENDENTE' || existente.status === 'PAGO') {
        return { status: 200, body: await visaoPublica(existente) };
      }
      return erroComNovoPedido(409, 'Este Pix foi cancelado. Confirme o pedido de novo para gerar outro.');
    }

    const erro = validarPedido(body);
    if (erro) return erroComNovoPedido(400, erro);

    // 6 cobranças NOVAS por IP a cada 10 min (protege o limite de vendas pendentes)
    if ((await store.contarTentativa('pix:' + ip, 600)) > 6) {
      return { status: 429, body: { erro: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.' } };
    }

    const qtd = Number(body.qtd);
    const valores = calcularTotal(qtd);
    const amount = valores.total / 100; // em reais
    const c = body.cliente;
    const e = body.entrega;
    const comp = String(e.comp || '').trim();
    const cep = digits(e.cep);
    const entrega = {
      cep, rua: e.rua.trim(), numero: e.numero.trim(), comp, bairro: e.bairro.trim(), cidade: e.cidade.trim(), uf: e.uf,
    };
    const enderecoTexto = `${entrega.rua}, ${entrega.numero}${comp ? ' - ' + comp : ''} - ${entrega.bairro} - ` +
      `${entrega.cidade}/${entrega.uf} - CEP ${cep.slice(0, 5)}-${cep.slice(5)}`;

    const payload = {
      identifier: id, // único por pedido: a SigiloPay também recusa repetição
      amount,
      client: { name: c.nome.trim(), email: c.email.trim(), phone: digits(c.whats), document: digits(c.cpf) },
      // Uma linha com preço = amount: a soma dos produtos bate exatamente com o valor cobrado
      products: [{ id: PRODUTO.id, name: `${PRODUTO.nome}${qtd > 1 ? ' × ' + qtd : ''} (Pix −5%)`, quantity: 1, price: amount }],
      metadata: { loja: 'Noturna', pedido: id, quantidade: String(qtd), entrega: enderecoTexto },
      callbackUrl: publicUrl + WEBHOOK_PATH, // URL fixa para todas as transações (limite de 20 webhooks)
    };

    let resposta, texto, data;
    try {
      resposta = await fetch(SIGILOPAY_API + '/gateway/pix/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-public-key': publicKey, 'x-secret-key': secretKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      texto = await resposta.text();
      try { data = JSON.parse(texto); } catch (_) { data = null; }
    } catch (err) {
      // Pode ter sido criada mesmo assim (timeout): mantém o número do pedido,
      // e a SigiloPay recusa o mesmo identifier se a cliente tentar de novo.
      console.error(`[sigilopay] ${id} falha de conexão:`, err.message);
      return { status: 502, body: { erro: 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.' } };
    }

    if (!resposta.ok || !data) {
      console.error(`[sigilopay] ${id} HTTP ${resposta.status}`, data ? JSON.stringify(data) : String(texto).slice(0, 200));
      return erroComNovoPedido(502, mensagemDeErro(resposta.status, data, texto || ''));
    }
    if (data.status === 'FAILED' || data.transactionStatus === 'FAILED') {
      console.error(`[sigilopay] ${id} cobrança recusada:`, data.errorDescription || data.details || JSON.stringify(data));
      return erroComNovoPedido(502, 'O banco não aceitou gerar este Pix. Confira seus dados ou tente de novo em instantes.');
    }
    const codigoPix = data.pix && data.pix.code;
    if (!data.transactionId || typeof codigoPix !== 'string' || !codigoPix) {
      console.error(`[sigilopay] ${id} resposta sem transactionId ou pix.code:`, JSON.stringify(data));
      return erroComNovoPedido(502, 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.');
    }
    if (!data.webhookToken) {
      console.error(`[sigilopay] ${id} resposta sem webhookToken: o pagamento não poderá ser confirmado automaticamente.`);
    }

    const pedido = {
      id,
      status: 'PENDENTE',
      criadoEm: new Date().toISOString(),
      produto: PRODUTO.nome,
      qtd,
      valores,
      cliente: { nome: payload.client.name, email: payload.client.email, whats: payload.client.phone, cpf: payload.client.document },
      entrega,
      transactionId: String(data.transactionId),
      sigilopayPedido: (data.order && data.order.id) || null,
      taxa: typeof data.fee === 'number' ? data.fee : null,
      pix: { code: codigoPix, expiraEm: (data.pix && data.pix.expiresAt) || null },
      webhookTokenHash: data.webhookToken ? sha256(data.webhookToken) : null, // só o hash é guardado
      eventos: [],
    };
    await store.salvarPedido(pedido);
    console.log(`[pedido] ${id} criado · transação ${pedido.transactionId} · ${qtd}x · R$ ${amount.toFixed(2)}`);

    return { status: 201, body: await visaoPublica(pedido) };
  } finally {
    await store.destravar(id);
  }
}

// ------------------------------------------------------------------
// POST /api/webhook/sigilopay
// O status segue o NOME do evento (documentação: Webhooks → Pagamentos).
// ------------------------------------------------------------------
const EVENTOS = {
  TRANSACTION_CREATED: null, // só registra
  TRANSACTION_PAID: 'PAGO',
  TRANSACTION_CANCELED: 'CANCELADO',
  TRANSACTION_REFUNDED: 'ESTORNADO',
  TRANSACTION_CHARGED_BACK: 'CHARGEBACK',
};

async function receberWebhook({ body }) {
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false } };

  const tx = body.transaction || {};
  const identifier = tx.identifier || body.identifier;
  const transactionId = String(tx.id || body.transactionId || '');

  let pedido = null;
  if (typeof identifier === 'string' && ID_PEDIDO.test(identifier)) pedido = await store.buscarPedido(identifier);
  if (!pedido && transactionId) pedido = await store.buscarPorTransacao(transactionId);
  if (!pedido) {
    console.warn('[webhook] Pedido não encontrado:', identifier || transactionId);
    return { status: 404, body: { ok: false } };
  }

  // Autenticidade: token do aviso = webhookToken recebido ao criar a cobrança
  if (!pedido.webhookTokenHash || typeof body.token !== 'string' || !igualSeguro(sha256(body.token), pedido.webhookTokenHash)) {
    console.warn('[webhook] Token inválido para o pedido', pedido.id);
    return { status: 401, body: { ok: false } };
  }
  if (transactionId && transactionId !== pedido.transactionId) {
    console.warn('[webhook] transactionId não confere para o pedido', pedido.id);
    return { status: 401, body: { ok: false } };
  }

  const evento = String(body.event || '').toUpperCase();
  pedido.eventos.push({ evento, em: new Date().toISOString() });
  const status = EVENTOS[evento] || null;
  // Pedido pago não volta para "cancelado"; só estorno/chargeback mudam um pago
  if (status && !(pedido.status === 'PAGO' && status === 'CANCELADO')) {
    pedido.status = status;
    pedido.atualizadoEm = new Date().toISOString();
    if (status === 'PAGO') pedido.pagoEm = pedido.atualizadoEm;
  }
  await store.salvarPedido(pedido);
  console.log(`[webhook] ${pedido.id} · ${evento} → ${pedido.status}`);
  return { status: 200, body: { ok: true } };
}

// ------------------------------------------------------------------
// GET /api/pedido/:id: status para o checkout e a página de obrigado
// ------------------------------------------------------------------
async function statusPedido({ query }) {
  const id = String((query && query.id) || '');
  if (!ID_PEDIDO.test(id)) return { status: 404, body: { erro: 'Pedido não encontrado.' } };
  const pedido = await store.buscarPedido(id);
  if (!pedido) return { status: 404, body: { erro: 'Pedido não encontrado.' } };
  return { status: 200, body: await visaoPublica(pedido) };
}

// ------------------------------------------------------------------
// Adaptador HTTP (igual na Vercel e no servidor local)
// ------------------------------------------------------------------
function enviar(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function handler(metodo, fn) {
  return async (req, res) => {
    if (req.method !== metodo) return enviar(res, 405, { erro: 'Método não permitido.' });
    try {
      let body = null;
      if (metodo === 'POST') {
        try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch (_) { body = null; }
      }
      const r = await fn({ body, ip: ipDe(req), query: req.query || {} });
      return enviar(res, r.status, r.body);
    } catch (err) {
      console.error('[erro]', err.message);
      return enviar(res, err.config ? 503 : 500, { erro: err.config ? 'Pagamento indisponível no momento.' : 'Erro interno. Tente de novo.' });
    }
  };
}

module.exports = { criarPix, receberWebhook, statusPedido, handler, config, WEBHOOK_PATH };
