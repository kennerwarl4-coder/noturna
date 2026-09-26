# Loja Noturna: como rodar

## 1. Instalar
Precisa do Node.js 22.9 ou mais novo.

```
npm install
```

## 2. Configurar a SigiloPay
1. Copie `.env.example` para `.env`.
2. No painel da SigiloPay: **Integrações → API → Gerar credenciais** (com a permissão `PRODUCER_TRANSACTIONS`).
3. Cole a chave pública e a secreta no `.env`.
4. Em `PUBLIC_URL`, coloque o endereço público da loja com `https://`.

O `.env` guarda a chave secreta: **nunca** envie esse arquivo para o GitHub nem para ninguém.

## 3. Rodar
```
npm start
```
A loja abre em http://localhost:3000.

## Como o pagamento funciona
1. A cliente confirma o pedido no checkout.
2. O `server.js` calcula o valor (o preço fica no servidor, não no navegador) e cria a cobrança na SigiloPay.
3. O QR Code e o copia e cola aparecem na tela.
4. Quando a cliente paga, a SigiloPay avisa o servidor em `PUBLIC_URL/api/webhook/sigilopay`.
5. O servidor confere o token do aviso, marca o pedido como PAGO e o checkout mostra "Pagamento confirmado".

Os pedidos ficam em `data/pedidos.json`, com nome, CPF e endereço. Esse arquivo não pode ficar público (LGPD).

## Publicar
A loja precisa de um servidor Node (Render, Railway, VPS etc.). Hospedagem só de arquivos (GitHub Pages, Netlify estático) não funciona.
- O servidor precisa estar no **Brasil, EUA ou Portugal**, senão a SigiloPay bloqueia as requisições.
- Em hospedagem com proxy (Render, Railway, Cloudflare), use `TRUST_PROXY=1`.
- No computador local, o webhook não chega (a SigiloPay não enxerga o `localhost`). Para testar o webhook localmente, use um túnel como `cloudflared` ou `ngrok` e coloque a URL dele em `PUBLIC_URL`.

## Para mudar o preço
Altere `precoCentavos` em `server.js` e os preços exibidos em `index.html` e `checkout.html`.
