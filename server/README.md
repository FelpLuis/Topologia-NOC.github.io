# Hospedagem própria — sistema.updown.com.br (190.111.110.14)

O NOC sai da Cloudflare e passa a rodar no mesmo servidor onde já está o banco.
São quatro peças no 190.111.110.14:

| Peça | Onde | Porta |
| --- | --- | --- |
| `sqld` (Turso local, dono do banco) | serviço `sqld` | 127.0.0.1:8080 |
| Worker rodando em Node (`server/node-server.mjs`) | serviço `noc` | 127.0.0.1:8787 |
| Caddy (TLS + roteamento) | serviço `caddy` | 0.0.0.0:80 e :443 |
| Apps Flutter (web) | arquivos estáticos | `/var/www/chat`, `/var/www/chatbot` |

Nada além do Caddy escuta na internet. O painel do NOC, a API, o app do cliente
(`/chat/`) e o webchat (`/chatbot/`) ficam **na mesma origem** — é o que dispensa
CORS, ausente nas respostas do chat em `src/worker.js`.

## Estado atual (14/09/2026)

- O servidor já responde em `https://noc.190-111-110-14.sslip.io` (certificado
  válido, login redirecionando).
- `sistema.updown.com.br` ainda aponta para **31.57.174.90**, o IXC (Central do
  Assinante). O DNS de `updown.com.br` é da HostGator
  (`ns182/ns183.hostgator.com.br`), TTL de 4 h.

Ou seja: falta virar o DNS e trocar o nome em quatro lugares.

## 1. DNS na HostGator

O nome **já existe e está em uso**: hoje `sistema.updown.com.br` resolve para
`31.57.174.90` — um nginx com certificado `CN=ixc.updown.com.br` que redireciona
para `/central_assinante_web/`, ou seja, a Central do Assinante do IXC. Virar o
registro tira a Central desse endereço (decisão tomada em 14/09/2026); se ela
ainda for usada, publique-a em outro nome antes — por exemplo um A
`central → 31.57.174.90` na mesma zona, lembrando que o IXC precisa aceitar o
nome novo e ter certificado para ele.

No cPanel → *Zone Editor* → `updown.com.br`, edite o registro A de `sistema`:

```
sistema   A   190.111.110.14
```

Baixe o TTL para 300 algumas horas **antes** da troca, se puder: com os 14400
atuais, quem já resolveu o nome vai continuar caindo no IXC por até 4 h.

Confira antes de mexer no servidor — o Caddy só consegue emitir o certificado
depois que o nome resolve para cá:

```bash
dig +short sistema.updown.com.br @8.8.8.8
```

Se um dia o domínio for para a Cloudflare, mantenha a nuvem **cinza** (DNS only)
ou o desafio ACME do Caddy morre no proxy.

## 2. Caddy

```bash
sudo cp /opt/noc/server/Caddyfile.example /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 50 --no-pager   # o certificado sai aqui
```

Para um corte sem janela, sirva os dois nomes durante a transição e remova o
sslip depois que o tráfego migrar:

```
sistema.updown.com.br, noc.190-111-110-14.sslip.io {
```

## 3. Aplicação (`/etc/noc.env`)

O único valor amarrado ao nome é o retorno do OAuth:

```
OAUTH_REDIRECT_URI=https://sistema.updown.com.br/api/auth/oauth/callback
```

```bash
sudo systemctl restart noc
```

Esse mesmo endereço precisa estar cadastrado como *redirect URI* no provedor de
identidade — se só um dos lados mudar, o login por OAuth devolve erro do IdP, não
do NOC.

## 4. Apps Flutter

O padrão de `API_BASE_URL` já é o domínio novo nos dois apps, mas o valor entra
no bundle **em tempo de build**: sem recompilar, o app publicado continua batendo
no host antigo.

```bash
# app do cliente
cd /c/projetoNOC/chat
flutter build web --release --base-href /chat/ \
  --dart-define=API_BASE_URL=https://sistema.updown.com.br

# webchat
cd /c/projetoNOC/chatbot
flutter build web --release --base-href /chatbot/ \
  --dart-define=API_BASE_URL=https://sistema.updown.com.br
```

Publique `build/web/` em `/var/www/chat` e `/var/www/chatbot` (o `handle_path` do
Caddy remove o prefixo, por isso o `--base-href` é obrigatório). O APK Android do
`chat` também precisa de rebuild e redistribuição — ele não tem outra forma de
saber o endereço novo.

O botão "Central do Assinante" do app `chat` continua desligado enquanto
`centralAssinanteUrl` estiver vazio. Como a Central sai de
`sistema.updown.com.br` nesta troca, quando ela tiver endereço novo rebuilde com
`--dart-define=CENTRAL_ASSINANTE_URL=https://...` — o app não descobre sozinho.

## 5. Coletor GPON (Windows, Tarefa Agendada)

Em `.collector.env`:

```
GPON_PUSH_URL=https://sistema.updown.com.br/api/gpon/ingest
```

Reinicie a tarefa `NOC-Coletor-GPON`. Mande o coletor para **um** destino só: se
ele continuar empurrando para o Worker da Cloudflare, metade da coleta vai parar
no banco antigo (Turso na nuvem) e a tela do NOC vai mostrar buraco no histórico.

## 6. Webhooks externos

Trocar a URL no painel de quem chama:

- WhatsApp Cloud API (Meta): `https://sistema.updown.com.br/api/whatsapp/webhook`
- Opa!Suite: `https://sistema.updown.com.br/api/opasuite/webhook`

## 7. Verificação

```bash
curl -sI https://sistema.updown.com.br/ | head -3          # 303 para /login.html
curl -sI https://sistema.updown.com.br/chat/ | head -3     # 200 text/html
curl -sI https://sistema.updown.com.br/chatbot/ | head -3  # 200 text/html
```

Depois, no navegador: login interno, um atendimento no `/chat/` e uma sincronização
do coletor. O backup diário (`noc-backup.timer`) não depende do domínio, mas vale
conferir que continua verde: `systemctl list-timers noc-backup.timer`.
