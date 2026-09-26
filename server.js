/*
 * Servidor LOCAL da loja Noturna (npm start)
 * ------------------------------------------------------------------
 * Em produção, a Vercel faz este papel: serve public/ e roda as funções de api/.
 * Aqui reproduzimos o mesmo comportamento para testar no computador,
 * usando exatamente as mesmas funções (lib/loja.js).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handler, criarPix, receberWebhook, statusPedido, config, WEBHOOK_PATH } = require('./lib/loja');
const { usaRedis } = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const rotas = {
  '/api/pix': handler('POST', criarPix),
  [WEBHOOK_PATH]: handler('POST', receberWebhook),
};
const rotaPedido = handler('GET', statusPedido);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// Lê o corpo JSON (a Vercel faz isso sozinha e entrega em req.body)
function lerCorpo(req, limite = 64 * 1024) {
  return new Promise((resolve) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) { req.destroy(); resolve(null); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function servirArquivo(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { rel = ''; }
  const arquivo = path.normalize(path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel));
  const tipo = MIME[path.extname(arquivo).toLowerCase()];
  // Só arquivos de dentro de public/
  if (!arquivo.startsWith(PUBLIC_DIR + path.sep) || !tipo) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  fs.readFile(arquivo, (err, conteudo) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': tipo });
    res.end(conteudo);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const { pathname } = new URL(req.url, 'http://localhost');

  if (rotas[pathname]) {
    if (req.method === 'POST') req.body = await lerCorpo(req);
    return rotas[pathname](req, res);
  }
  const m = pathname.match(/^\/api\/pedido\/([^/]+)$/);
  if (m) {
    req.query = { id: m[1] };
    return rotaPedido(req, res);
  }
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ erro: 'Rota não encontrada.' }));
  }
  if (req.method === 'GET' || req.method === 'HEAD') return servirArquivo(res, pathname);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  const { publicKey, secretKey, publicUrl } = config();
  console.log(`Noturna rodando em http://localhost:${PORT}`);
  console.log(`Pedidos salvos em: ${usaRedis ? 'Upstash Redis' : 'data/pedidos.json'}`);
  if (!publicKey || !secretKey) console.warn('⚠ Chaves da SigiloPay ausentes no .env: o Pix não será gerado.');
  if (!publicUrl) console.warn('⚠ PUBLIC_URL ausente no .env: a SigiloPay não terá para onde mandar o webhook.');
  else if (!publicUrl.startsWith('https://')) console.warn('⚠ PUBLIC_URL deve ser https:// e acessível pela internet.');
});
