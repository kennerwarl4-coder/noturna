# Loja Noturna

Página de produto + checkout Pix via SigiloPay, pronta para a Vercel.

## Estrutura

```
public/            o site (é só isso que fica público)
  index.html       página do produto
  checkout.html    checkout em 3 etapas
  assets/          logo e fotos otimizadas
api/               funções da Vercel
  pix.js                  POST /api/pix               cria a cobrança Pix
  webhook/sigilopay.js    POST /api/webhook/sigilopay recebe a confirmação de pagamento
  pedido/[id].js          GET  /api/pedido/:id        status do pedido (usado pelo checkout)
lib/
  loja.js          preço, validações e integração SigiloPay
  store.js         onde os pedidos ficam (Upstash Redis na Vercel, arquivo no computador)
server.js          servidor para rodar no computador (npm start)
design/            imagens originais (não vão para o site)
```

## Publicar na Vercel

1. **Importar o projeto:** vercel.com → Add New → Project → escolha o repositório `noturna`.
   Framework Preset: **Other**. Não precisa mudar mais nada (o `vercel.json` já configura tudo).
2. **Banco dos pedidos (obrigatório):** no projeto, **Storage → Create Database → Upstash (Redis)**
   e conecte ao projeto. As variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` são criadas sozinhas.
   Escolha a região **São Paulo (gru1)** ou a mais próxima.
3. **Variáveis de ambiente:** Settings → Environment Variables, ambiente **Production**:
   - `SIGILOPAY_PUBLIC_KEY`: chave pública (painel SigiloPay → Integrações → API)
   - `SIGILOPAY_SECRET_KEY`: chave secreta
   - `PUBLIC_URL`: o domínio final com https, ex.: `https://www.noturna.com.br`
     (se ficar vazio, usa o domínio `.vercel.app` do projeto)
4. **Região das funções:** Settings → Functions → Function Region → **São Paulo (gru1)**.
   A SigiloPay só aceita requisições vindas do Brasil, EUA ou Portugal.
5. **Deploy:** depois de salvar as variáveis, faça um novo deploy (Deployments → Redeploy).

### Depois do deploy, confira
- Abra o site, faça um pedido de teste e veja se o QR Code aparece.
- Pague um valor baixo e confirme que a tela muda para "Pagamento confirmado".
- Se algo falhar: Vercel → projeto → **Logs**. As mensagens começam com `[sigilopay]`, `[webhook]` ou `[config]`.

O webhook é enviado para `PUBLIC_URL/api/webhook/sigilopay`. Use sempre o domínio de **produção**:
os deploys de preview da Vercel ficam protegidos por login e a SigiloPay não consegue acessá-los.

## Rodar no computador

Precisa do Node.js 22.9 ou mais novo.

```
npm install
cp .env.example .env     (e preencha as chaves)
npm start
```

A loja abre em http://localhost:3000. Sem Redis configurado, os pedidos vão para `data/pedidos.json`.
O webhook não chega no `localhost`. Para testá-lo, use um túnel (`cloudflared` ou `ngrok`) e coloque a URL dele em `PUBLIC_URL`.

## Segurança
- As chaves da SigiloPay ficam só nas variáveis de ambiente. Nunca no código nem no GitHub.
- O preço é calculado no servidor (`lib/loja.js`). O navegador não consegue alterar o valor cobrado.
- O webhook só é aceito se o token bater com o que a SigiloPay devolveu ao criar a cobrança.
- Os pedidos têm nome, CPF e endereço (LGPD): não compartilhe o acesso ao Redis.

## Para mudar o preço
Altere `precoCentavos` em `lib/loja.js` e os preços exibidos em `public/index.html` e `public/checkout.html`.
