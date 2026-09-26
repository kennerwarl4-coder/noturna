/*
 * Servidor da loja Noturna
 * ------------------------------------------------------------------
 * - Serve a loja (index.html, checkout.html, assets/)
 * - POST /api/pix               cria a cobrança Pix na SigiloPay
 * - POST /api/webhook/sigilopay recebe a confirmação de pagamento
 * - GET  /api/pedido/:id        status do pedido (o checkout consulta este servidor,
 *                               nunca a SigiloPay, que bloqueia polling)
 *
 * As chaves da SigiloPay ficam só aqui, no .env. Nunca no HTML.
 * Rodar: npm install  →  npm start
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

// ------------------------------------------------------------------
// Configuração (.env)
// ------------------------------------------------------------------
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const SIGILOPAY_API = 'https://app.sigilopay.com.br/api/v1';
const PUBLIC_KEY = process.env.SIGILOPAY_PUBLIC_KEY || '';
const SECRET_KEY = process.env.SIGILOPAY_SECRET_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
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
// Pedidos: arquivo JSON simples (data/pedidos.json).
// Suficiente para começar; com volume, troque por um banco de dados.
// Contém dados pessoais (LGPD): não publique a pasta data/.
// ------------------------------------------------------------------
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pedidos.json');
let pedidos = {};
try { pedidos = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { /* primeiro uso */ }

function salvarPedidos() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pedidos, null, 2));
  fs.renameSync(tmp, DB_FILE); // troca atômica: nunca deixa o arquivo pela metade
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

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function lerJson(req, limite = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (chunk) => {
      tamanho += chunk.length;
      if (tamanho > limite) { reject(new Error('corpo grande demais')); req.destroy(); return; }
      partes.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function ipDe(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Limite simples: 6 cobranças Pix por IP a cada 10 minutos.
// Protege o limite de "vendas pendentes" da SigiloPay contra abuso.
const tentativas = new Map();
function limitado(ip) {
  const agora = Date.now();
  const janela = (tentativas.get(ip) || []).filter((t) => agora - t < 10 * 60 * 1000);
  janela.push(agora);
  tentativas.set(ip, janela);
  return janela.length > 6;
}

// ------------------------------------------------------------------
// POST /api/pix: cria a cobrança
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
  if (!/^[A-Z]{2}$/.test(String(e.uf || ''))) return 'Estado inválido.';
  return '';
}

// Converte os erros da SigiloPay em mensagens para a cliente.
// O detalhe técnico vai para o log do servidor.
function mensagemDeErro(status, data, texto) {
  const codigo = (data && (data.errorCode || (data.error && data.error.code))) || '';
  if (status === 403 && /<html/i.test(texto)) {
    console.error('[sigilopay] Requisição bloqueada por localização. O servidor precisa estar no Brasil, EUA ou Portugal.');
  }
  if (codigo === 'TOO_MANY_REQUESTS' || status === 429) return 'Muitos pedidos aguardando pagamento agora. Tente de novo em alguns minutos.';
  if (codigo === 'GATEWAY_INVALID_ARGUMENT' || codigo === 'GATEWAY_INVALID_DATA' || status === 400 || status === 422) {
    return 'Algum dado não foi aceito pelo banco. Confira nome, e-mail, WhatsApp e CPF.';
  }
  return 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.';
}

async function criarPix(req, res) {
  if (!PUBLIC_KEY || !SECRET_KEY || !PUBLIC_URL) {
    console.error('[config] Defina SIGILOPAY_PUBLIC_KEY, SIGILOPAY_SECRET_KEY e PUBLIC_URL no .env');
    return json(res, 503, { erro: 'Pagamento indisponível no momento.' });
  }
  if (limitado(ipDe(req))) return json(res, 429, { erro: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.' });

  let body;
  try { body = await lerJson(req); } catch (_) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  const erro = validarPedido(body);
  if (erro) return json(res, 400, { erro });

  const qtd = Number(body.qtd);
  const valores = calcularTotal(qtd);
  const id = 'NOT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const c = body.cliente;
  const e = body.entrega;

  const payload = {
    identifier: id,
    amount: valores.total / 100, // em reais
    client: {
      name: c.nome.trim(),
      email: c.email.trim(),
      phone: digits(c.whats),
      document: digits(c.cpf),
    },
    callbackUrl: PUBLIC_URL + WEBHOOK_PATH, // URL fixa para todas as transações (limite de 20 webhooks)
  };

  let resposta, texto, data;
  try {
    resposta = await fetch(SIGILOPAY_API + '/gateway/pix/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-public-key': PUBLIC_KEY, 'x-secret-key': SECRET_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    texto = await resposta.text();
    try { data = JSON.parse(texto); } catch (_) { data = null; }
  } catch (err) {
    console.error('[sigilopay] Falha de conexão:', err.message);
    return json(res, 502, { erro: 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.' });
  }

  if (!resposta.ok || !data) {
    console.error('[sigilopay] HTTP', resposta.status, data ? JSON.stringify(data) : texto.slice(0, 200));
    return json(res, 502, { erro: mensagemDeErro(resposta.status, data, texto || '') });
  }

  const codigoPix = data.pix && data.pix.code;
  if (!data.transactionId || typeof codigoPix !== 'string' || !codigoPix) {
    console.error('[sigilopay] Resposta sem transactionId ou pix.code:', JSON.stringify(data));
    return json(res, 502, { erro: 'Não conseguimos gerar o Pix agora. Tente de novo em instantes.' });
  }
  if (!data.webhookToken) {
    console.warn('[sigilopay] Resposta sem webhookToken: a confirmação automática deste pedido não poderá ser validada.');
  }

  pedidos[id] = {
    id,
    status: 'PENDENTE',
    criadoEm: new Date().toISOString(),
    produto: PRODUTO.nome,
    qtd,
    valores,
    cliente: { nome: payload.client.name, email: payload.client.email, whats: payload.client.phone, cpf: payload.client.document },
    entrega: { cep: digits(e.cep), rua: e.rua.trim(), numero: e.numero.trim(), comp: String(e.comp || '').trim(), bairro: e.bairro.trim(), cidade: e.cidade.trim(), uf: e.uf },
    transactionId: String(data.transactionId),
    webhookTokenHash: data.webhookToken ? sha256(data.webhookToken) : null, // guardamos só o hash
    eventos: [],
  };
  salvarPedidos();
  console.log(`[pedido] ${id} criado · ${qtd}x · R$ ${(valores.total / 100).toFixed(2)}`);

  // QR Code gerado aqui a partir do código copia e cola
  const qrCode = await QRCode.toDataURL(codigoPix, { margin: 1, width: 480, color: { dark: '#222222', light: '#FFFFFF' } });
  return json(res, 201, { pedido: id, total: valores.total / 100, pix: { copiaECola: codigoPix, qrCode } });
}

// ------------------------------------------------------------------
// POST /api/webhook/sigilopay: confirmação de pagamento
// ------------------------------------------------------------------
function novoStatus(evento, statusTransacao) {
  const ev = String(evento || '').toUpperCase();
  const st = String(statusTransacao || '').toUpperCase();
  if (ev === 'TRANSACTION_PAID' || st === 'COMPLETED') return 'PAGO';
  if (st === 'REFUNDED' || ev.includes('REFUND')) return 'ESTORNADO';
  if (st === 'CHARGED_BACK' || ev.includes('CHARGEBACK')) return 'CHARGEBACK';
  if (st === 'FAILED' || ev.includes('CANCEL') || ev.includes('FAIL')) return 'FALHOU';
  return null;
}

async function webhook(req, res) {
  let body;
  try { body = await lerJson(req, 64 * 1024); } catch (_) { return json(res, 400, { ok: false }); }

  const tx = body.transaction || {};
  const identifier = tx.identifier || body.identifier;
  const transactionId = String(tx.id || body.transactionId || '');
  const pedido = (identifier && pedidos[identifier]) ||
    (transactionId && Object.values(pedidos).find((p) => p.transactionId === transactionId));

  if (!pedido) {
    console.warn('[webhook] Pedido não encontrado:', identifier || transactionId);
    return json(res, 404, { ok: false });
  }
  // Autenticidade: o token do webhook precisa bater com o recebido ao criar a cobrança
  if (!pedido.webhookTokenHash || typeof body.token !== 'string' || !igualSeguro(sha256(body.token), pedido.webhookTokenHash)) {
    console.warn('[webhook] Token inválido para o pedido', pedido.id);
    return json(res, 401, { ok: false });
  }
  if (transactionId && transactionId !== pedido.transactionId) {
    console.warn('[webhook] transactionId não confere para o pedido', pedido.id);
    return json(res, 401, { ok: false });
  }

  pedido.eventos.push({ evento: body.event || null, status: tx.status || null, em: new Date().toISOString() });
  const status = novoStatus(body.event, tx.status);
  // Um pedido pago não volta a "falhou"; só estorno/chargeback mudam um pago.
  if (status && !(pedido.status === 'PAGO' && status === 'FALHOU')) {
    pedido.status = status;
    pedido.atualizadoEm = new Date().toISOString();
    console.log(`[webhook] ${pedido.id} → ${status}`);
  }
  salvarPedidos();
  return json(res, 200, { ok: true });
}

// ------------------------------------------------------------------
// GET /api/pedido/:id: o checkout pergunta se já foi pago
// ------------------------------------------------------------------
function statusPedido(res, id) {
  const pedido = pedidos[id];
  if (!pedido) return json(res, 404, { erro: 'Pedido não encontrado.' });
  return json(res, 200, { pedido: pedido.id, status: pedido.status }); // sem dados pessoais
}

// ------------------------------------------------------------------
// Arquivos estáticos (só o que é público)
// ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const PUBLICOS = new Set(['index.html', 'checkout.html']);

function servirArquivo(res, urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const arquivo = path.normalize(path.join(ROOT, rel));
  rel = path.relative(ROOT, arquivo).split(path.sep).join('/');
  const permitido = PUBLICOS.has(rel) || rel.startsWith('assets/');
  if (!permitido || rel.includes('..') || !MIME[path.extname(arquivo).toLowerCase()]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  fs.readFile(arquivo, (err, conteudo) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arquivo).toLowerCase()],
      'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(conteudo);
  });
}

// ------------------------------------------------------------------
// Rotas
// ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'POST' && pathname === '/api/pix') return await criarPix(req, res);
    if (req.method === 'POST' && pathname === WEBHOOK_PATH) return await webhook(req, res);
    const m = pathname.match(/^\/api\/pedido\/([A-Za-z0-9-]{1,64})$/);
    if (req.method === 'GET' && m) return statusPedido(res, m[1]);
    if (pathname.startsWith('/api/')) return json(res, 404, { erro: 'Rota não encontrada.' });
    if (req.method === 'GET' || req.method === 'HEAD') return servirArquivo(res, pathname);
    res.writeHead(405); res.end();
  } catch (err) {
    console.error('[erro]', err);
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno. Tente de novo.' });
  }
});

server.listen(PORT, () => {
  console.log(`Noturna rodando em http://localhost:${PORT}`);
  if (!PUBLIC_KEY || !SECRET_KEY) console.warn('⚠ Chaves da SigiloPay ausentes no .env: o Pix não será gerado.');
  if (!PUBLIC_URL) console.warn('⚠ PUBLIC_URL ausente no .env: a SigiloPay não terá para onde mandar o webhook.');
  else if (!PUBLIC_URL.startsWith('https://')) console.warn('⚠ PUBLIC_URL deve ser https:// e acessível pela internet.');
});
