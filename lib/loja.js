/*
 * Regras da loja + integração Pix SigiloPay
 * ------------------------------------------------------------------
 * Usado pelas funções da Vercel (api/) e pelo servidor local (server.js).
 * Cada função devolve { status, body } e não sabe onde está rodando.
 */
'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const store = require('./store');

const SIGILOPAY_API = 'https://app.sigilopay.com.br/api/v1';
const WEBHOOK_PATH = '/api/webhook/sigilopay';

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
// Configuração (lida a cada chamada: na Vercel vem das Environment Variables)
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
  // Na Vercel (ou atrás de proxy confiável) o IP real vem nos cabeçalhos
  if (process.env.VERCEL || process.env.TRUST_PROXY === '1') {
    return String(h['x-real-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

// ------------------------------------------------------------------
// Criar cobrança Pix
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
    console.error('[sigilopay] Bloqueio por localização: o servidor precisa estar no Brasil, EUA ou Portugal.');
  }
  if (codigo === 'TOO_MANY_REQUESTS' || status === 429) return 'Muitos pedidos aguardando pagamento agora. Tente de novo em alguns minutos.';
  if (codigo === 'GATEWAY_INVALID_ARGUMENT' || codigo === 'GATEWAY_INVALID_DATA' || status === 400 || status === 422) {
    return 'Algum dado não foi aceito pelo banco. Confira nome, e-mail, WhatsApp e CPF.';
  }
  return 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.';
}

async function criarPix({ body, ip }) {
  const { publicKey, secretKey, publicUrl } = config();
  if (!publicKey || !secretKey || !publicUrl) {
    console.error('[config] Defina SIGILOPAY_PUBLIC_KEY, SIGILOPAY_SECRET_KEY e PUBLIC_URL.');
    return { status: 503, body: { erro: 'Pagamento indisponível no momento.' } };
  }

  // 6 cobranças por IP a cada 10 min: protege o limite de vendas pendentes da SigiloPay
  if ((await store.contarTentativa('pix:' + ip, 600)) > 6) {
    return { status: 429, body: { erro: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.' } };
  }

  if (!body || typeof body !== 'object') return { status: 400, body: { erro: 'Pedido inválido.' } };
  const erro = validarPedido(body);
  if (erro) return { status: 400, body: { erro } };

  const qtd = Number(body.qtd);
  const valores = calcularTotal(qtd);
  const id = 'NOT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const c = body.cliente;
  const e = body.entrega;

  const amount = valores.total / 100; // em reais
  const payload = {
    identifier: id,
    amount,
    client: { name: c.nome.trim(), email: c.email.trim(), phone: digits(c.whats), document: digits(c.cpf) },
    // Uma linha só, com preço = amount: a soma dos produtos sempre bate exatamente com o valor
    // cobrado (price × qtd − desconto pode divergir em ponto flutuante na 14ª casa).
    products: [{
      id: PRODUTO.id,
      name: `${PRODUTO.nome}${qtd > 1 ? ' × ' + qtd : ''} (Pix −5%)`,
      quantity: 1,
      price: amount,
    }],
    metadata: { loja: 'Noturna', pedido: id, quantidade: String(qtd) },
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
    console.error('[sigilopay] Falha de conexão:', err.message);
    return { status: 502, body: { erro: 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.' } };
  }

  if (!resposta.ok || !data) {
    console.error('[sigilopay] HTTP', resposta.status, data ? JSON.stringify(data) : String(texto).slice(0, 200));
    return { status: 502, body: { erro: mensagemDeErro(resposta.status, data, texto || '') } };
  }

  // A SigiloPay pode responder 200 com status FAILED
  if (data.status === 'FAILED' || data.transactionStatus === 'FAILED') {
    console.error('[sigilopay] Cobrança recusada:', data.errorDescription || data.details || JSON.stringify(data));
    return { status: 502, body: { erro: 'O banco não aceitou gerar este Pix. Confira seus dados ou tente de novo em instantes.' } };
  }

  const codigoPix = data.pix && data.pix.code;
  if (!data.transactionId || typeof codigoPix !== 'string' || !codigoPix) {
    console.error('[sigilopay] Resposta sem transactionId ou pix.code:', JSON.stringify(data));
    return { status: 502, body: { erro: 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.' } };
  }
  if (!data.webhookToken) {
    console.warn('[sigilopay] Resposta sem webhookToken: a confirmação automática deste pedido não poderá ser validada.');
  }

  await store.salvarPedido({
    id,
    status: 'PENDENTE',
    criadoEm: new Date().toISOString(),
    produto: PRODUTO.nome,
    qtd,
    valores,
    cliente: { nome: payload.client.name, email: payload.client.email, whats: payload.client.phone, cpf: payload.client.document },
    entrega: {
      cep: digits(e.cep), rua: e.rua.trim(), numero: e.numero.trim(), comp: String(e.comp || '').trim(),
      bairro: e.bairro.trim(), cidade: e.cidade.trim(), uf: e.uf,
    },
    transactionId: String(data.transactionId),
    sigilopayPedido: (data.order && data.order.id) || null,
    taxa: typeof data.fee === 'number' ? data.fee : null,
    pixExpiraEm: (data.pix && data.pix.expiresAt) || null,
    webhookTokenHash: data.webhookToken ? sha256(data.webhookToken) : null, // só o hash é guardado
    eventos: [],
  });
  console.log(`[pedido] ${id} criado · ${qtd}x · R$ ${amount.toFixed(2)}`);

  const qrCode = await QRCode.toDataURL(codigoPix, { margin: 1, width: 480, color: { dark: '#222222', light: '#FFFFFF' } });
  return {
    status: 201,
    body: { pedido: id, total: amount, pix: { copiaECola: codigoPix, qrCode, expiraEm: (data.pix && data.pix.expiresAt) || null } },
  };
}

// ------------------------------------------------------------------
// Webhook da SigiloPay
// ------------------------------------------------------------------
// O status do pedido segue o NOME do evento (documentação: Webhooks → Pagamentos).
// Não usamos transaction.status: até o TRANSACTION_CREATED pode vir com "COMPLETED".
const EVENTOS = {
  TRANSACTION_CREATED: null, // só registra
  TRANSACTION_PAID: 'PAGO',
  TRANSACTION_CANCELED: 'CANCELADO',
  TRANSACTION_REFUNDED: 'ESTORNADO',
  TRANSACTION_CHARGED_BACK: 'CHARGEBACK',
};
function novoStatus(evento) {
  return EVENTOS[String(evento || '').toUpperCase()] || null;
}

async function receberWebhook({ body }) {
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false } };

  const tx = body.transaction || {};
  const identifier = tx.identifier || body.identifier;
  const transactionId = String(tx.id || body.transactionId || '');

  let pedido = null;
  if (typeof identifier === 'string' && /^NOT-[A-F0-9]{16}$/.test(identifier)) pedido = await store.buscarPedido(identifier);
  if (!pedido && transactionId) pedido = await store.buscarPorTransacao(transactionId);
  if (!pedido) {
    console.warn('[webhook] Pedido não encontrado:', identifier || transactionId);
    return { status: 404, body: { ok: false } };
  }

  // Autenticidade: o token precisa bater com o recebido ao criar a cobrança
  if (!pedido.webhookTokenHash || typeof body.token !== 'string' || !igualSeguro(sha256(body.token), pedido.webhookTokenHash)) {
    console.warn('[webhook] Token inválido para o pedido', pedido.id);
    return { status: 401, body: { ok: false } };
  }
  if (transactionId && transactionId !== pedido.transactionId) {
    console.warn('[webhook] transactionId não confere para o pedido', pedido.id);
    return { status: 401, body: { ok: false } };
  }

  pedido.eventos.push({ evento: body.event || null, status: tx.status || null, em: new Date().toISOString() });
  const status = novoStatus(body.event);
  // Pedido pago não volta para "cancelado"; só estorno/chargeback mudam um pago
  if (status && !(pedido.status === 'PAGO' && status === 'CANCELADO')) {
    pedido.status = status;
    pedido.atualizadoEm = new Date().toISOString();
    console.log(`[webhook] ${pedido.id} → ${status}`);
  }
  await store.salvarPedido(pedido);
  return { status: 200, body: { ok: true } };
}

// ------------------------------------------------------------------
// Status do pedido (consultado pelo checkout; sem dados pessoais)
// ------------------------------------------------------------------
async function statusPedido({ id }) {
  if (typeof id !== 'string' || !/^NOT-[A-F0-9]{16}$/.test(id)) return { status: 404, body: { erro: 'Pedido não encontrado.' } };
  const pedido = await store.buscarPedido(id);
  if (!pedido) return { status: 404, body: { erro: 'Pedido não encontrado.' } };
  return { status: 200, body: { pedido: pedido.id, status: pedido.status } };
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

// Envolve uma função da loja em um handler (req, res)
function handler(metodo, fn) {
  return async (req, res) => {
    if (req.method !== metodo) return enviar(res, 405, { erro: 'Método não permitido.' });
    try {
      let body = null;
      if (metodo === 'POST') {
        try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch (_) { body = null; }
      }
      const r = await fn({ body, ip: ipDe(req), id: req.query && req.query.id });
      return enviar(res, r.status, r.body);
    } catch (err) {
      console.error('[erro]', err);
      return enviar(res, err.config ? 503 : 500, { erro: err.config ? 'Pagamento indisponível no momento.' : 'Erro interno. Tente de novo.' });
    }
  };
}

module.exports = { criarPix, receberWebhook, statusPedido, handler, config, WEBHOOK_PATH };
