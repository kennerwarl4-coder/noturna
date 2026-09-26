/*
 * Armazenamento dos pedidos
 * ------------------------------------------------------------------
 * - Na Vercel: Upstash Redis (as funções não têm disco permanente).
 *   Instale pelo painel da Vercel: Storage → Upstash → Redis. As variáveis
 *   KV_REST_API_URL / KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_*) são criadas sozinhas.
 * - No computador (npm start): arquivo data/pedidos.json.
 *
 * Os pedidos têm dados pessoais (LGPD): não exponha nem o Redis nem a pasta data/.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const usaRedis = Boolean(REDIS_URL && REDIS_TOKEN);

function exigirBanco() {
  if (!usaRedis && process.env.VERCEL) {
    throw Object.assign(new Error('Banco não configurado: conecte o Upstash Redis ao projeto na Vercel.'), { config: true });
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

// ---------------- API usada pela loja ----------------
async function salvarPedido(pedido) {
  exigirBanco();
  if (usaRedis) {
    await redis('SET', 'pedido:' + pedido.id, JSON.stringify(pedido));
    await redis('SET', 'tx:' + pedido.transactionId, pedido.id); // índice para o webhook
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

// Contador com janela de tempo (limite de tentativas por IP)
const memoria = new Map();
async function contarTentativa(chave, janelaSegundos) {
  if (usaRedis) {
    const n = await redis('INCR', 'rl:' + chave);
    if (n === 1) await redis('EXPIRE', 'rl:' + chave, janelaSegundos);
    return n;
  }
  const agora = Date.now();
  const lista = (memoria.get(chave) || []).filter((t) => agora - t < janelaSegundos * 1000);
  lista.push(agora);
  memoria.set(chave, lista);
  return lista.length;
}

module.exports = { usaRedis, salvarPedido, buscarPedido, buscarPorTransacao, contarTentativa };
