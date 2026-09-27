# Loja Noturna

Página de produto + checkout Pix via SigiloPay, pronta para a Vercel. Sem banco de dados.

## Estrutura

```
public/            o site (é só isso que fica público)
  index.html       página do produto
  checkout.html    checkout em 3 etapas
  assets/          logo e fotos otimizadas
api/               funções da Vercel
  pix.js                  POST /api/pix               cria a cobrança Pix
  webhook/sigilopay.js    POST /api/webhook/sigilopay recebe os avisos de pagamento
  status.js               GET  /api/status            diz se a configuração está completa
lib/
  loja.js          preço, validações e integração SigiloPay
server.js          servidor para rodar no computador (npm start)
design/            imagens originais (não vão para o site)
```

## Publicar na Vercel

1. **Importar o projeto:** vercel.com → Add New → Project → repositório `noturna`.
   Framework Preset: **Other**. O `vercel.json` já configura o resto.
2. **Variáveis de ambiente:** Settings → Environment Variables, ambiente **Production**:
   - `SIGILOPAY_PUBLIC_KEY`: chave pública (painel SigiloPay → Integrações → API)
   - `SIGILOPAY_SECRET_KEY`: chave secreta
   - `PUBLIC_URL` (opcional): o domínio final com https, ex.: `https://www.noturna.com.br`.
     Se ficar vazio, usa o domínio de produção `.vercel.app`.
3. **Região das funções (recomendado):** Settings → Functions → Function Region → **São Paulo (gru1)**.
   A SigiloPay só aceita requisições vindas do Brasil, EUA ou Portugal.
4. **Deploy:** depois de salvar as variáveis, faça um **Redeploy** (variáveis só valem para deploys novos).
5. **Confira:** abra `/api/status` no seu domínio. Precisa aparecer `"pronto": true`.

## Onde ficam os pedidos

Não há banco de dados. Cada pedido fica na própria transação da SigiloPay:
- **Painel da SigiloPay:** cliente (nome, e-mail, WhatsApp, CPF), valor e produto.
  O **endereço de entrega** e o número do pedido da loja vão nos **metadata** da transação.
- **Logs da Vercel** (projeto → Logs): cada Pix gerado aparece como `[pedido]`, com endereço,
  e cada pagamento como `[PEDIDO PAGO]`. Os logs da Vercel são guardados por pouco tempo:
  use o painel da SigiloPay como registro oficial.

O webhook é validado por uma chave derivada da sua chave secreta, que vai na própria URL
cadastrada na cobrança. Se você trocar a chave secreta, os Pix antigos continuam pagáveis,
mas os avisos deles passam a ser recusados (só afeta o log).

## Rodar no computador

Precisa do Node.js 22.9 ou mais novo.

```
npm install
cp .env.example .env     (e preencha as chaves)
npm start
```

A loja abre em http://localhost:3000. O webhook não chega no `localhost`. Para testá-lo, use um túnel
(`cloudflared` ou `ngrok`) e coloque a URL dele em `PUBLIC_URL`.

## Segurança
- As chaves da SigiloPay ficam só nas variáveis de ambiente. Nunca no código nem no GitHub.
- O preço é calculado no servidor (`lib/loja.js`). O navegador não consegue alterar o valor cobrado.

## Para mudar o preço
Altere `precoCentavos` em `lib/loja.js` e os preços exibidos em `public/index.html` e `public/checkout.html`.
