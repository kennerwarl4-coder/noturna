# Loja Noturna

Página de produto + checkout Pix via SigiloPay, rodando na Vercel.

## Como o pagamento funciona

1. A cliente confirma o pedido. O checkout gera um **número de pedido** (`NOT-...`) e pede o Pix ao servidor.
2. O servidor (`/api/pix`) calcula o valor e cria **uma única** cobrança na SigiloPay para aquele número.
   Se a cliente clicar de novo, ou a conexão cair e ela tentar outra vez, o servidor devolve **o mesmo Pix**.
3. O checkout mostra o QR Code e pergunta ao servidor a cada 4 segundos se o pedido já foi pago (`/api/pedido/:id`).
4. Quando o Pix cai, a SigiloPay avisa o servidor pelo webhook (`/api/webhook/sigilopay`). O servidor confere o token
   do aviso e marca o pedido como **PAGO**.
5. Na consulta seguinte, o checkout leva a cliente para a **página de obrigado** (`obrigado.html`).

Se o celular recarregar a página quando a cliente voltar do app do banco, o checkout retoma o mesmo Pix.

O checkout consulta o **nosso** servidor, nunca a SigiloPay direto: a SigiloPay bloqueia consultas repetidas
e manda usar webhook. Por isso os pedidos precisam ficar guardados em um armazenamento (Upstash Redis).

## Estrutura

```
public/            o site (só isso fica público)
  index.html       página do produto
  checkout.html    checkout em 3 etapas + tela do Pix
  obrigado.html    página de obrigado (depois do pagamento)
  assets/          logo e fotos
api/               funções da Vercel
  pix.js                  POST /api/pix               cria (ou devolve) o Pix do pedido
  pedido/[id].js          GET  /api/pedido/:id        status do pedido
  webhook/sigilopay.js    POST /api/webhook/sigilopay avisos de pagamento da SigiloPay
  status.js               GET  /api/status            diz se a configuração está completa
lib/
  loja.js          preço, validações e integração SigiloPay
  store.js         pedidos no Upstash Redis (Vercel) ou em data/pedidos.json (computador)
server.js          servidor para rodar no computador (npm start)
design/            imagens originais (não vão para o site)
```

## Publicar na Vercel

1. **Armazenamento:** projeto → **Storage → Create Database → Upstash → Redis** (plano Free),
   região **São Paulo**, conecte ao projeto marcando **Production**. As variáveis são criadas sozinhas.
2. **Variáveis:** Settings → Environment Variables → **Production**:
   - `SIGILOPAY_PUBLIC_KEY` e `SIGILOPAY_SECRET_KEY` (painel SigiloPay → Integrações → API)
   - `PUBLIC_URL` (opcional): domínio final com https. Vazio = domínio de produção `.vercel.app`.
3. **Região das funções:** Settings → Functions → Function Region → **São Paulo (gru1)**.
4. **Redeploy** (variáveis novas só valem para deploys novos).
5. Abra **`/api/status`**: precisa mostrar `"pronto": true`.

## Onde ver os pedidos

- **Painel da SigiloPay:** cada transação tem cliente, valor, produto e, nos metadata, o número do pedido e o
  endereço de entrega.
- **Upstash (Vercel → Storage → Data Browser):** chaves `pedido:NOT-...` com todos os dados, inclusive status.
- **Logs da Vercel:** `[pedido]` quando o Pix é gerado, `[webhook]` quando o status muda.

Os pedidos têm nome, CPF e endereço (LGPD): não compartilhe o acesso ao Redis.

## Rodar no computador

Precisa do Node.js 22.9 ou mais novo.

```
npm install
cp .env.example .env     (e preencha as chaves)
npm start
```

A loja abre em http://localhost:3000, e os pedidos ficam em `data/pedidos.json`. O webhook não chega no
`localhost`: para testá-lo, use um túnel (`cloudflared` ou `ngrok`) e coloque a URL dele em `PUBLIC_URL`.

## Para mudar o preço
Altere `precoCentavos` em `lib/loja.js` e os preços exibidos em `public/index.html` e `public/checkout.html`.
