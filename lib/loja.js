/*
 * Regras da loja + integração Pix SigiloPay (sem banco de dados)
 * ------------------------------------------------------------------
 * Usado pelas funções da Vercel (api/) e pelo servidor local (server.js).
 * Cada função devolve { status, body } e não sabe onde está rodando.
 *
 * Nada é guardado aqui: os dados do pedido (cliente, valor e endereço de
 * entrega nos metadata) ficam na própria transação da SigiloPay.
 */
'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');

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

// Chave do webhook: derivada da chave secreta, então não precisa de variável
// nova nem de banco. Vai fixa na callbackUrl (uma URL só para todas as
// transações, dentro do limite de 20 webhooks da SigiloPay).
function chaveWebhook(secretKey) {
  return crypto.createHmac('sha256', secretKey).update('noturna-webhook').digest('hex').slice(0, 32);
}

// ------------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------------
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

// Limite de 6 cobranças por IP a cada 10 min, em memória.
// Sem banco, vale por instância da função: segura abusos simples.
const tentativas = new Map();
function limitado(ip) {
  const agora = Date.now();
  const janela = (tentativas.get(ip) || []).filter((t) => agora - t < 10 * 60 * 1000);
  janela.push(agora);
  tentativas.set(ip, janela);
  return janela.length > 6;
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
  if (status === 401 || codigo === 'GATEWAY_UNAUTHORIZED' || codigo === 'GATEWAY_INVALID_CREDENTIALS') {
    console.error('[sigilopay] Chaves recusadas: confira SIGILOPAY_PUBLIC_KEY e SIGILOPAY_SECRET_KEY.');
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
  if (limitado('pix:' + ip)) {
    return { status: 429, body: { erro: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.' } };
  }

  if (!body || typeof body !== 'object') return { status: 400, body: { erro: 'Pedido inválido.' } };
  const erro = validarPedido(body);
  if (erro) return { status: 400, body: { erro } };

  const qtd = Number(body.qtd);
  const valores = calcularTotal(qtd);
  const amount = valores.total / 100; // em reais
  const id = 'NOT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const c = body.cliente;
  const e = body.entrega;
  const comp = String(e.comp || '').trim();
  const cep = digits(e.cep);
  const enderecoEntrega = `${e.rua.trim()}, ${e.numero.trim()}${comp ? ' - ' + comp : ''} - ${e.bairro.trim()} - ` +
    `${e.cidade.trim()}/${e.uf} - CEP ${cep.slice(0, 5)}-${cep.slice(5)}`;

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
    // Sem banco, o endereço de entrega viaja junto com a transação
    metadata: { loja: 'Noturna', pedido: id, quantidade: String(qtd), entrega: enderecoEntrega },
    callbackUrl: `${publicUrl}${WEBHOOK_PATH}?chave=${chaveWebhook(secretKey)}`,
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

  // Registro nos logs da Vercel (sem CPF)
  console.log(`[pedido] ${id} · transação ${data.transactionId} · ${qtd}x · R$ ${amount.toFixed(2)} · ${payload.client.name} · ${enderecoEntrega}`);

  const qrCode = await QRCode.toDataURL(codigoPix, { margin: 1, width: 480, color: { dark: '#222222', light: '#FFFFFF' } });
  return {
    status: 201,
    body: { pedido: id, total: amount, pix: { copiaECola: codigoPix, qrCode, expiraEm: (data.pix && data.pix.expiresAt) || null } },
  };
}

// ------------------------------------------------------------------
// Webhook da SigiloPay
// Sem banco, ele só registra o evento nos logs da Vercel. É o ponto
// certo para, no futuro, mandar e-mail/WhatsApp de "pedido pago".
// ------------------------------------------------------------------
async function receberWebhook({ body, query }) {
  const { secretKey } = config();
  // Autenticidade: só a SigiloPay conhece a URL com a chave
  if (!secretKey || !igualSeguro(String((query && query.chave) || ''), chaveWebhook(secretKey))) {
    console.warn('[webhook] Chamada sem a chave correta: ignorada.');
    return { status: 401, body: { ok: false } };
  }
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false } };

  const tx = body.transaction || {};
  const evento = String(body.event || '');
  const cliente = body.client || {};
  const valor = typeof tx.amount === 'number' ? ' · R$ ' + tx.amount.toFixed(2) : '';
  console.log(`[webhook] ${evento} · transação ${tx.id || '?'}${valor} · ${cliente.name || ''} ${cliente.phone ? '· ' + cliente.phone : ''}`);
  if (evento === 'TRANSACTION_PAID') {
    console.log(`[PEDIDO PAGO] transação ${tx.id || '?'}: separe e envie (endereço nos metadata da transação no painel SigiloPay)`);
  }
  return { status: 200, body: { ok: true } };
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
      const r = await fn({ body, ip: ipDe(req), query: req.query || {} });
      return enviar(res, r.status, r.body);
    } catch (err) {
      console.error('[erro]', err);
      return enviar(res, 500, { erro: 'Erro interno. Tente de novo.' });
    }
  };
}

module.exports = { criarPix, receberWebhook, handler, config, WEBHOOK_PATH };
