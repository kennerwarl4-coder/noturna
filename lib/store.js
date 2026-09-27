/*
 * Armazenamento dos pedidos
 * ------------------------------------------------------------------
 * Por que existe: a SigiloPay avisa o pagamento pelo webhook, e o checkout
 * precisa consultar esse status depois. Na Vercel cada requisição roda
 * isolada e não lembra nada, então o status tem que ficar guardado.
 *
 * - Na Vercel: Upstash Redis (Storage → Upstash → Redis, plano grátis).
 *   As variáveis KV_REST_API_URL / KV_REST_API_TOKEN são criadas sozinhas
 *   (com ou sem prefixo personalizado).
 * - No computador (npm start): arquivo data/pedidos.json.
 *
 * Os pedidos têm dados pessoais (LGPD): não compartilhe o acesso ao Redis.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function acharVariavel(nomes) {
  // Remove espaços e aspas em volta (comum ao colar "valor" no painel da Vercel)
  const limpar = (v) => String(v || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  for (const n of nomes) if (process.env[n]) return limpar(process.env[n]);
  const chave = Object.keys(process.env).find((k) => process.env[k] && nomes.some((n) => k.endsWith('_' + n)));
  return chave ? limpar(process.env[chave]) : '';
}
const REDIS_URL = acharVariavel(['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL']);
const REDIS_TOKEN = acharVariavel(['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN']); // nunca o READ_ONLY
const usaRedis = Boolean(REDIS_URL && REDIS_TOKEN);

function exigirBanco() {
  if (!usaRedis && process.env.VERCEL) {
    throw Object.assign(new Error('Banco não configurado: conecte o Upstash Redis ao projeto na Vercel (Storage).'), { config: true });
  }
}

// ---------------- Redis (API REST da Upstash, sem dependências) ----------------
async function redis(...comando) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error('Redis: ' + (data.error || 'HTTP ' + r.status));
  return data.result;
}

// ---------------- Arquivo local ----------------
const DB_FILE = path.join(__dirname, '..', 'data', 'pedidos.json');
function lerArquivo() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { return {}; }
}
function gravarArquivo(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // troca atômica
}

// ---------------- Pedidos ----------------
async function salvarPedido(pedido) {
  exigirBanco();
  if (usaRedis) {
    await redis('SET', 'pedido:' + pedido.id, JSON.stringify(pedido));
    if (pedido.transactionId) await redis('SET', 'tx:' + pedido.transactionId, pedido.id); // índice para o webhook
    return;
  }
  const db = lerArquivo();
  db[pedido.id] = pedido;
  gravarArquivo(db);
}

async function buscarPedido(id) {
  exigirBanco();
  if (usaRedis) {
    const s = await redis('GET', 'pedido:' + id);
    return s ? JSON.parse(s) : null;
  }
  return lerArquivo()[id] || null;
}

async function buscarPorTransacao(transactionId) {
  exigirBanco();
  if (usaRedis) {
    const id = await redis('GET', 'tx:' + transactionId);
    return id ? buscarPedido(id) : null;
  }
  return Object.values(lerArquivo()).find((p) => p.transactionId === transactionId) || null;
}

// ---------------- Trava: impede criar duas cobranças para o mesmo pedido ao mesmo tempo ----------------
const travasLocais = new Map();
async function travar(chave, segundos) {
  exigirBanco();
  if (usaRedis) return (await redis('SET', 'trava:' + chave, '1', 'NX', 'EX', segundos)) === 'OK';
  const agora = Date.now();
  if ((travasLocais.get(chave) || 0) > agora) return false;
  travasLocais.set(chave, agora + segundos * 1000);
  return true;
}
async function destravar(chave) {
  if (usaRedis) { await redis('DEL', 'trava:' + chave).catch(() => {}); return; }
  travasLocais.delete(chave);
}

// ---------------- Contador com janela de tempo (limite de tentativas por IP) ----------------
const contadores = new Map();
async function contarTentativa(chave, janelaSegundos) {
  exigirBanco();
  if (usaRedis) {
    const n = await redis('INCR', 'rl:' + chave);
    if (n === 1) await redis('EXPIRE', 'rl:' + chave, janelaSegundos);
    return n;
  }
  const agora = Date.now();
  const lista = (contadores.get(chave) || []).filter((t) => agora - t < janelaSegundos * 1000);
  lista.push(agora);
  contadores.set(chave, lista);
  return lista.length;
}

// Usado por /api/status
async function diagnosticoBanco() {
  if (!usaRedis) return process.env.VERCEL ? 'não configurado' : 'arquivo local';
  try { return (await redis('PING')) === 'PONG' ? 'ok' : 'resposta inesperada'; }
  catch (err) { console.error('[status] Redis:', err.message); return 'erro de conexão'; }
}

module.exports = {
  usaRedis, salvarPedido, buscarPedido, buscarPorTransacao, travar, destravar, contarTentativa, diagnosticoBanco,
};
