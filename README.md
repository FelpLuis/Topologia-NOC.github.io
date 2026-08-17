# UPDOWN Topologia NOC — Cloudflare Worker + Static Assets

A aplicação agora usa **Cloudflare Worker + Static Assets**. Isso permite manter o site estático e, ao mesmo tempo, criar uma API segura para consultar o Zabbix sem expor o token no navegador.

## Estrutura

```text
/
├── public/
│   ├── index.html
│   ├── dashboard.html
│   ├── css/
│   ├── js/
│   ├── data/
│   └── assets/
├── src/
│   └── worker.js
├── wrangler.jsonc
├── wrangler.example.jsonc
└── README.md
```

### O que cada parte faz

- `public/`: todo o site que o navegador acessa.
- `public/index.html`: aplicação principal da topologia.
- `public/dashboard.html`: dashboard para TV.
- `public/js/app.js`: topologia, equipamentos, portas e edição.
- `public/js/noc-dashboard.js`: dashboard por POP.
- `public/js/noc-trafego.js`: tela de tráfego das interfaces.
- `public/data/equipamentos.json`: cadastro dos equipamentos e portas.
- `public/data/conexoes.json`: ligações entre equipamentos.
- `public/data/pops.json`: cadastro dos POPs.
- `src/worker.js`: API do sistema e intermediária entre a página e o Zabbix.
- `src/zabbix.js`, `src/zabbix-links.js`, `src/zabbix-topology.js`: integração Zabbix.
- `wrangler.jsonc`: configuração do Worker.

## 1. Credenciais do Zabbix

A integração de monitoramento é o Zabbix (ver **Integração Zabbix**, mais
abaixo). As credenciais são Secrets do Worker, nunca vars nem código:

```bash
npx wrangler secret put ZABBIX_URL
```

```bash
npx wrangler secret put ZABBIX_TOKEN
```

## 2. Deploy

Antes do primeiro uso da aba **Conexão**, cadastre a chave que protege as
senhas individuais de acesso aos aparelhos:

```bash
npx wrangler secret put DEVICE_CREDENTIALS_KEY
```

Informe uma chave aleatória com pelo menos 32 caracteres. Não troque essa
chave sem antes planejar o recadastro das senhas já salvas.

O comando de deploy passa a ser:

```bash
npx wrangler deploy
```

Não use mais:

```bash
npx wrangler build
```

O `wrangler.jsonc` já informa:

```json
{
  "main": "src/worker.js",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  }
}
```

## 3. Testar o Worker

Depois do deploy:

```text
https://topologia-noc.luis-felipe-f25.workers.dev/api/zabbix/health
```

Com os Secrets configurados, a resposta traz a versão da API e a contagem de hosts:

```json
{
  "ok": true,
  "version": "7.0.20",
  "hosts": 278
}
```

Se não estiver configurado, será retornado um erro explicando o problema.

## 4. Integração das portas

Já está feita, pelo Zabbix. Cada porta de equipamento monitorado carrega a
identidade real da interface, e o vínculo é o inventário sincronizado:

```json
{
  "numero": 5,
  "nome": "100GE1/0/27",
  "capacidade": "100 Gbps",
  "tipo": "100G",
  "status": "conectada",
  "descricao": "NE8000_F1A-100GE0/1/48",
  "zabbix": { "hostid": "34520", "ifIndex": 28, "operStatus": 1, "speedBps": 100000000000 }
}
```

`descricao` é o `ifAlias` do equipamento — é dele que os enlaces são
derivados. `operStatus` alimenta o status nas telas (1 = up, 2 = down).
RX/TX e utilização ficam em `/api/zabbix/interfaces` e na tela de Tráfego,
em vez de duplicados na topologia: assim o número na tela é sempre o da
última sincronização, e não uma cópia envelhecida.

## 5. Dashboard TV

A Dashboard continua disponível em:

```text
/dashboard.html
```

O botão **Dashboard** da aplicação principal continua apontando para essa página.

Ela está organizada por POP:

- POP ASCENTY
- POP PRAIA GRANDE
- POP SANTOS
- POP SÃO VICENTE
- POP CUBATÃO

Cada equipamento mostra:

- status;
- quantidade de portas;
- portas utilizadas;
- portas livres;
- barra de utilização.

Status e utilização vêm do inventário do Zabbix aplicado à topologia. O tráfego
por interface fica na tela de **Tráfego** (`/trafego.html`).

## 6. NE F1A

A visualização 3D usa a frente do equipamento e as portas estão organizadas em:

```text
01 02 03 ... 26 27 28
29 30 31 ... 54 55 56
```

Portas livres possuem destaque visual.

## Segurança

Nunca faça isto:

```javascript
const ZABBIX_TOKEN = "4a46...";
```

Use sempre:

```text
Cloudflare Secret → ZABBIX_TOKEN
```

O navegador conversa apenas com:

```text
/api/zabbix/*
```

e o Worker conversa com o Zabbix.

O Worker é executado antes dos assets (`run_worker_first`): páginas internas,
scripts operacionais e arquivos de `public/data` exigem sessão, e as páginas do
catálogo também são verificadas contra `role_screens` no servidor. As rotas do
Zabbix exigem `zabbix.view`, `zabbix.sync` ou `zabbix.link`.

No D1, dados de requisições nunca são concatenados em SQL. Valores usam
prepared statements com `.bind()`; identificadores usados pelas rotinas de
migração são validados por lista/formato seguro antes de entrar no comando.

## GitHub

Suba todos os arquivos deste projeto para o repositório.

Depois faça o deploy pelo Cloudflare.

Se o Cloudflare estiver conectado ao GitHub, o comando de deploy configurado deve ser:

```text
npx wrangler deploy
```

Não configure o diretório de assets como `.`. Ele deve ser:

```text
./public
```



## Backend, Login, RBAC e Auditoria

O projeto agora possui backend Node.js + SQLite.

### Primeiro acesso

Não existe mais credencial padrão. Para uma instalação nova, defina uma senha
temporária forte em `BOOTSTRAP_ADMIN_PASSWORD` usando um Cloudflare Secret. O
Worker cria a conta somente se ela ainda não existir e exige a troca da senha.
Depois do primeiro acesso, remova o Secret de bootstrap.

```bash
npx wrangler secret put BOOTSTRAP_ADMIN_PASSWORD
```

### OAuth 2.0 / OpenID Connect

O login corporativo usa Authorization Code, PKCE (`S256`), `state`, `nonce` e
validação da assinatura RS256 do ID Token. Configure `OAUTH_ISSUER` e
`OAUTH_CLIENT_ID` como variáveis e o segredo do cliente separadamente:

```bash
npx wrangler secret put OAUTH_CLIENT_SECRET
```

Cadastre no provedor a callback
`https://SEU-DOMINIO/api/auth/oauth/callback`. Para limitar o vínculo de contas,
configure `OAUTH_ALLOWED_DOMAINS`. Por padrão não há provisionamento automático;
uma identidade precisa corresponder ao e-mail verificado de um usuário existente.
`OAUTH_ALLOW_USERNAME_LINK=true` permite também o vínculo por
`preferred_username` e deve ser usado somente com um issuer corporativo confiável.
Depois de validar o acesso corporativo, `PASSWORD_LOGIN_ENABLED=false` desativa o
login por senha local.

### Perfis RBAC

Os perfis oficiais do sistema são:

| Perfil | Permissões padrão |
|---|---|
| `administrador` | Acesso total: topologia, usuários, RBAC, auditoria e configurações |
| `analista` | Visualizar/alterar/excluir topologia e consultar auditoria |
| `atendimento` | Somente consulta da topologia |
| `tecnico` | Visualizar e alterar equipamentos, portas e conexões |
| `logistica` | Visualizar e alterar informações operacionais da topologia |

Os nomes exibidos na interface são **Administrador, Analista, Atendimento, Técnico e Logística**.

Quando criado pelo Secret de bootstrap, o usuário inicial recebe o perfil `administrador`.

Perfis antigos da primeira versão (`admin`, `editor`, `viewer`) são migrados automaticamente para `administrador`, `analista` e `atendimento`, respectivamente, quando o script de inicialização é executado.

As permissões passaram a ser o **catálogo de ações** descrito em
[Catálogo de telas e ações](#catálogo-de-telas-e-ações). `topology.view`,
`topology.edit`, `topology.delete`, `users.view`, `users.manage`, `audit.view` e
`settings.manage` continuam existindo, agora acompanhadas das ações granulares
de cada funcionalidade.

### Auditoria

Toda operação relevante do backend gera um registro em `audit_logs`, incluindo:

- login bem-sucedido e falho;
- logout;
- troca de senha;
- criação de usuário;
- alteração de usuário;
- ativação/desativação;
- exclusão;
- alterações de topologia quando feitas pela API.

O registro guarda usuário, data/hora, ação, recurso, IP, user-agent e, quando aplicável, estado anterior e posterior.

### Banco

O banco SQLite fica em:

```text
backend/data/topologia.db
```

Ele é criado pelo:

```bash
npm run init-db
```

### Instalação

```bash
npm install
npm run init-db
npm start
```

O servidor escuta por padrão em:

```text
http://127.0.0.1:3000
```

### Administração

Depois de entrar como admin:

```text
/admin.html
```

A tela permite criar, ativar/desativar e excluir usuários e consultar a auditoria.

### Importante sobre o backend

A camada RBAC já está pronta e os endpoints de autenticação/usuários/auditoria estão funcionais. As operações antigas da interface que ainda escrevem diretamente nos JSONs devem ser migradas para endpoints protegidos do backend antes de serem consideradas completamente auditadas. Não é seguro declarar uma alteração como auditada enquanto ela puder contornar a API.


## Auditoria completa da topologia

A topologia deixou de ser persistida no `localStorage` do navegador.

Todas as alterações realizadas pela interface passam por:

```text
Interface
  ↓
PUT /api/topology
  ↓
RBAC (topology.edit)
  ↓
SQLite topology_state
  ↓
audit_logs
```

O registro de auditoria de uma alteração de topologia contém:

- usuário responsável;
- data/hora;
- IP;
- método e rota;
- versão anterior e nova;
- snapshot completo antes da alteração;
- snapshot completo depois da alteração;
- resumo e diff de equipamentos, POPs e conexões.

Isso cobre alterações de:

- nome/modelo/categoria/local/núcleo de equipamentos;
- quantidade e dados das portas;
- capacidade, tipo, status e observações;
- conexão/porta remota;
- criação e exclusão de equipamentos;
- POPs;
- equipamentos dos POPs;
- rotas e informações dos POPs;
- títulos e textos configuráveis da tela.

A API de topologia exige autenticação e a permissão `topology.edit` para qualquer alteração.

### Histórico da topologia

Administradores podem consultar:

```text
GET /api/topology/history
```

e a tela administrativa continua disponível em:

```text
/admin.html
```

### Importante

Os arquivos em `public/data/*.json` permanecem como **dados iniciais/fallback de implantação**. Depois da inicialização, a fonte oficial de dados é o banco SQLite `backend/data/topologia.db`. O navegador não grava mais alterações nesses arquivos nem no `localStorage`.


### Controle de exclusão

O RBAC separa alteração de exclusão:

- `topology.edit`: criar/alterar dados.
- `topology.delete`: remover equipamentos, POPs, conexões ou reduzir portas.

O perfil `admin` possui ambas. O perfil `editor` não pode realizar exclusões. Tentativas de exclusão sem permissão também são registradas na auditoria.


## Login — Glassmorphism / Network Intelligence

A tela de login foi redesenhada com referência estética ao conceito de glassmorphism do modelo indicado pelo usuário, sem copiar os elementos proprietários do template. Mantém a identidade UPDOWN TELECOM e usa uma composição visual própria de análise de redes: topologia, CORE, POP, BGP, MPLS, tráfego e monitoramento de portas.

O fundo é vetorial/CSS e não depende de imagens externas, com animação respeitando `prefers-reduced-motion`.


## Perfis RBAC oficiais

O sistema utiliza seis perfis:

| Perfil | Permissões |
|---|---|
| Administrador | Acesso total |
| Gerente | Acesso gerencial à operação, topologia, usuários e auditoria |
| Analista | Topologia completa + auditoria |
| Atendimento | Somente visualização |
| Técnico | Visualização + edição de equipamentos, portas e conexões |
| Logística | Visualização + edição de informações operacionais |

O perfil **Gerente** possui as mesmas permissões administrativas operacionais do Administrador, porém o desenho permite futuramente restringir funções administrativas sensíveis sem alterar a estrutura do RBAC.

A troca de perfil pela tela administrativa também passa pela API e é auditada.


## Gerenciar Plataforma

Administradores agora possuem o botão **Gerenciar plataforma** ao lado de **Gerenciar rede** e **Dashboard**.

A tela `/platform.html` concentra:

- **Perfis e permissões:** criar, editar e excluir perfis e definir permissões;
- **Telas do sistema:** definir quais telas existem e ativar/desativar;
- **Visibilidade por perfil:** escolher quais telas cada perfil pode abrir;
- **Gerenciar usuários:** criar usuários, trocar perfil, ativar/desativar e redefinir senha;
- **Auditoria:** consultar as alterações administrativas.

Administrar perfis exige a ação `roles.manage` e ativar/desativar telas exige `screens.manage` — por padrão, só o perfil `administrador` tem as duas, mas agora isso é configurável como qualquer outra ação. As alterações são auditadas.


## CORREÇÃO CLOUDFLARE D1

O `wrangler.jsonc` usa o D1 existente no seu Worker:

- Binding: `bd`
- Database: `topologia-noc`
- Database ID: `b2559011-42bd-49d0-a22b-5c22efce1913`
- Assets: `ASSETS`

O erro `binding bd of type d1 must have a valid database_id` acontecia porque o projeto estava usando um placeholder de `database_id`. Isso foi corrigido.

O projeto também não usa mais `better-sqlite3`, `express` ou `cookie-parser` no deploy do Worker.

### Teste

Depois do deploy, abra:

`/api/health`

O resultado esperado é:

```json
{"ok":true,"service":"topologia-noc","database":"D1","binding":"bd"}
```

Login inicial:

```text
Usuário: admin
Senha: admin
```


## CORREÇÃO DO ERRO D1_EXEC_ERROR

O bootstrap do banco foi alterado para usar `db.prepare()` + `db.batch()`, em vez de enviar o schema inteiro via `db.exec()` durante o login.

Isso elimina o erro:

```text
D1_EXEC_ERROR: Error in line 1:
CREATE TABLE IF NOT EXISTS roles (: incomplete input
```

O Worker cria cada tabela individualmente e de forma idempotente.



## Correção de compatibilidade da auditoria D1

O erro `no such column: occurred_at` foi corrigido. O projeto agora usa `audit_logs.created_at`, compatível com a tabela criada nas versões anteriores. O Worker também verifica a estrutura existente do D1 e cria `created_at` quando necessário, sem apagar os dados existentes.


## Correção V4 — coluna `screens.route`

O D1 existente já tinha a tabela `screens`, mas sem a coluna `route`. O Worker agora verifica `PRAGMA table_info(screens)` e adiciona `route` somente se necessário. Nenhum dado existente é apagado.


## Correção V5 — símbolo da marca
O ícone compacto da tela de login não usa mais apenas `U`. Ele foi substituído pelo símbolo textual `up`, mantendo azul/ciano e o restante da identidade visual UPDOWN.


## V6 — compatibilidade D1 e marca compacta

- O login agora usa `UP` em maiúsculas no símbolo compacto.
- A classe `.brand-mark` foi ajustada para impedir retorno visual a `U`/`up`.
- O Worker faz migração incremental das colunas de `users`, `sessions`, `audit_logs`, `screens` e `topology_state`.
- `sessions.token_hash` é garantido para compatibilidade com versões anteriores.
- A criação de sessão fornece um ID explícito, evitando conflito com bancos antigos.
- Não apaga o D1 existente.


## V7 — Ícone oficial UPDOWN

O ícone compacto da interface agora utiliza exatamente a imagem fornecida pelo usuário,
armazenada em `public/assets/up-symbol.png`. O sistema não redesenha o símbolo nem usa
texto `U`/`UP` como substituto.


## Logo oficial na tela de login

A tela de login deve utilizar `public/assets/updown-symbol.png`, que é exatamente o símbolo gráfico enviado pelo usuário. Não utilizar texto `U`, `UP` ou `up` como substituto.


## Novo front do NOC (V2)

A interface foi refeita sobre a mesma API, o mesmo D1 e o mesmo RBAC:

- `/` — topologia em dois níveis: **POP → equipamentos → portas**, com expandir/recolher por localidade;
- `/pops.html` — POPs, rotas do anel e vínculo de equipamentos;
- `/dashboard.html` — Dashboard NOC agrupado pelo POP vinculado, com modo TV;
- `/platform.html` — perfis, permissões, telas, usuários e auditoria;
- `/login.html` e `/change-password.html` — acesso e troca de senha;
- `/legado.html` — **editor clássico completo**, com o markup e o `js/app.js` originais (portas, enlaces, POPs e títulos).

O equipamento passou a ter o campo `popId`: um equipamento pertence a um único POP,
e é esse vínculo que organiza o Dashboard. Vincular/desvincular fica em
**Topologia → Gerenciar rede → Vínculo com POP** e é gravado por `PUT /api/topology`,
com auditoria. Equipamento sem vínculo aparece em "Sem POP vinculado", nunca some.

Detalhes de arquitetura, decisões de UX e o que ainda vive no editor clássico:
[FRONT-NOC-V2.md](FRONT-NOC-V2.md).

Protótipo navegável (dados fixos, sem API): `public/prototype/index.html`.

---

## Integração Zabbix

Conexão com a API JSON-RPC do Zabbix (`https://zbx7.lv.network/api_jsonrpc.php`,
versão 7.0.20) para importar o inventário real de interfaces dos equipamentos de
rede. O Zabbix continua sendo a fonte da verdade; o D1 guarda o resultado da
última sincronização, para que as telas leiam rápido e sem depender do Zabbix
estar no ar.

### Credenciais

Nunca ficam no código nem no `wrangler.jsonc`. São **Secrets** do Worker:

```bash
npx wrangler secret put ZABBIX_URL
```

```bash
npx wrangler secret put ZABBIX_TOKEN
```

Ao informar os valores no prompt, cole somente a URL ou o token, **sem aspas**.
Por exemplo: `https://zbx7.lv.network/api_jsonrpc.php`. Aspas salvas como parte
do Secret tornam a URL inválida.

Em desenvolvimento local o wrangler lê o arquivo `.dev.vars` (fora do Git).
A autenticação usa token via header `Authorization: Bearer` — não usa
`user.login`, então não há senha trafegando nem sessão do Zabbix para expirar.

### O que é importado

`host.get` filtra os hosts que têm interface SNMP (os equipamentos de rede) e
`item.get` traz os itens `net.if` de cada um. Os itens são agrupados por
`ifIndex`, virando uma linha por interface física:

| Coluna | Origem | Observação |
| --- | --- | --- |
| `if_name` | nome do item | ex.: `100GE1/0/1` |
| `if_alias` | nome do item | **descrição do enlace**, ex.: `NE8000_F1A-100GE0/1/48` |
| `oper_status` | `ifOperStatus` | 1 = up, 2 = down |
| `speed_bps` | `ifHighSpeed` | já vem em **bits/s** (100GE = 1e11), não em Mbps |
| `in_bps` / `out_bps` | `ifHCInOctets` / `ifHCOutOctets` | tráfego atual |
| `in_errors` / `out_errors` | `ifInErrors` / `ifOutErrors` | |
| `in_discards` / `out_discards` | `ifInDiscards` / `ifOutDiscards` | |

O `if_alias` é o dado mais valioso: é ele que documenta a ponta remota de cada
enlace, e os dois lados batem entre si. Exemplo real:

```
s6750a  100GE1/0/1  (SWITCH2_HW-S6730-ASCENTY-100GE-0/0/6)
s6730a  100GE0/0/6  (SWITCH_HW-S6750-ASCENTY-100GE-1/0/1)
```

### Vínculo com a topologia

`zabbix_hosts.equipamento_id` liga o host do Zabbix ao equipamento da topologia.
As regras de correspondência automática ficam em `HOST_MATCH_RULES`
(`src/zabbix.js`) — são explícitas de propósito, porque um match errado poluiria
a topologia. Um vínculo ajustado à mão (`match_source='manual'`) **não é
desfeito** pela sincronização automática.

### Sincronizar

Pelo próprio sistema, com auditoria e controle de permissão:

```bash
curl -X POST https://SEU-WORKER/api/zabbix/sync
```

Ou pela linha de comando, útil para a carga inicial:

```bash
node backend/scripts/zabbix-sync.mjs --apply
```

O script sem `--apply` só gera `backend/data/zabbix-sync.sql` e
`backend/data/zabbix-inventory.json` para conferência (ambos fora do Git).

### Endpoints

| Método | Rota | Permissão |
| --- | --- | --- |
| `GET` | `/api/zabbix/health` | `zabbix.view` |
| `GET` | `/api/zabbix/status` | `zabbix.view` |
| `GET` | `/api/zabbix/hosts` | `zabbix.view` |
| `GET` | `/api/zabbix/interfaces` | `zabbix.view` |
| `GET` | `/api/zabbix/links` | `zabbix.view` |
| `GET` | `/api/zabbix/overview` | `zabbix.view` |
| `GET` | `/api/zabbix/history` | `zabbix.view` |
| `POST` | `/api/zabbix/sync` | `zabbix.sync` |
| `PATCH` | `/api/zabbix/hosts/:hostid` | `zabbix.link` |
| `GET` | `/api/trafego/settings` | `zabbix.view` |
| `PUT` | `/api/trafego/settings` | `trafego.settings` |

Filtros de `/api/zabbix/interfaces`: `equipamento`, `hostid`, `status=up|down`,
`conectadas=1` (só as com enlace documentado), `q` (busca em nome e alias) e
`limit`.

`/api/zabbix/overview` devolve, **em uma requisição**, tudo o que o painel de
tráfego desenha na abertura: ajustes, status da sincronização, hosts,
interfaces, enlaces derivados e histórico do período. Ele existe porque a tela
abria com três chamadas — `interfaces`, `links` e `status` — e cada uma relia
`zabbix_interfaces` inteira. Aqui a leitura acontece uma vez e alimenta os dois
recortes. Os endpoints antigos continuam publicados e sem alteração.

`/api/zabbix/history?horas=N` devolve a série agregada da rede
(`zabbix_traffic_snapshots`): **uma linha por sincronização**, com entrada,
saída, interfaces no ar, saturadas e erros. A série por interface continua no
Zabbix — guardar 2 000 séries por ciclo custaria mais do que vale a miniatura
de 30 pixels que a tabela mostra, e essa miniatura é montada na memória da aba.

### Sincronização automática

`wrangler.jsonc` declara um cron de 5 em 5 minutos que chama o mesmo caminho do
botão “Sincronizar agora”, registrando a execução em `zabbix_sync_runs` com
`source='cron'`. Sem `ZABBIX_URL` e `ZABBIX_TOKEN` configurados, o gatilho não
faz nada. É o que mantém o telão do NOC certo sem alguém clicando em nada.

```jsonc
"triggers": { "crons": ["*/5 * * * *"] }
```

**Custo de escrita no D1.** Cada ciclo regrava uma linha por interface. Com ~750
interfaces, 5 em 5 minutos dá **~216 mil linhas gravadas por dia** — acima do
limite diário do plano gratuito do D1 (100 mil) e confortável no plano pago.
O intervalo é uma decisão de operação, e muda em uma linha: `*/10` corta pela
metade, `*/15` divide por três. O snapshot do histórico acrescenta só 1 linha
por ciclo.

Em desenvolvimento o cron não dispara sozinho; para testar:

```bash
curl "http://127.0.0.1:8788/cdn-cgi/local/scheduled"
```

No front, `NOC.zabbix` (`public/js/noc-api.js`) cobre todos eles, junto de
`NOC.formatBps()` e `NOC.interfaceStatus()` para exibição. O painel é atualizado
automaticamente a cada 10 segundos enquanto a opção “Atualizar sozinho” estiver
ativada. Essa leitura não dispara uma nova coleta no Zabbix; ela apenas busca o
espelho mais recente já salvo no D1.


## Catálogo de telas e ações

Toda tela e toda funcionalidade do sistema são **declaradas no catálogo do
Worker** (`SCREENS` e `ACTIONS` em `src/worker.js`) e aparecem em
`/platform.html` → **Perfis e ações**, onde são marcadas perfil a perfil.

- **Tela** responde por *onde o perfil entra* (`screens` + `role_screens`).
- **Ação** responde por *o que ele faz lá dentro* (`permissions` + `role_permissions`).

### Telas

| Código | Rota | Tela |
| --- | --- | --- |
| `network` | `/` | Topologia |
| `gpon` | `/gpon.html` | Topologia GPON |
| `pops` | `/pops.html` | POPs e anel óptico |
| `dashboard` | `/dashboard.html` | Dashboard NOC |
| `trafego` | `/trafego.html` | Tráfego |
| `platform` | `/platform.html` | Gerenciar plataforma |
| `legado` | `/legado.html` | Editor clássico |

O menu lateral, o menu inferior e o guardião de rotas (`public/js/auth-guard.js`)
são montados a partir desse catálogo: incluir uma tela nova no `SCREENS` já a
coloca em Perfis, no menu e sob controle de acesso, sem lista fixa no front.

### Ações

| Módulo | Ações |
| --- | --- |
| Topologia (`network`) | `topology.view`, `topology.edit`, `topology.delete`, `topology.equipment.create`, `topology.equipment.edit`, `topology.equipment.delete`, `topology.port.edit`, `topology.link.create`, `topology.link.delete`, `topology.pop.link`, `topology.layout`, `topology.config` |
| Monitoramento Zabbix (`network`) | `zabbix.view`, `zabbix.sync`, `zabbix.link` |
| Tráfego (`trafego`) | `trafego.settings` |
| POPs e anel (`pops`) | `pops.create`, `pops.edit`, `pops.delete`, `pops.order`, `pops.routes`, `pops.ring.layout` |
| Plataforma (`platform`) | `roles.view`, `roles.manage`, `screens.manage`, `users.view`, `users.manage`, `users.password`, `audit.view`, `audit.export`, `settings.manage` |

`topology.edit` e `topology.delete` continuam sendo a base de qualquer gravação
ou remoção na topologia; as ações granulares são exigidas **além** delas.

### Como a ação é verificada

A topologia é gravada inteira em `PUT /api/topology`, então o Worker deduz as
ações exigidas do **diff entre o estado anterior e o enviado**
(`requiredTopologyActions`) — nunca de um rótulo mandado pelo cliente. Criar um
POP exige `pops.create`, mexer em portas exige `topology.port.edit`, arrastar o
mapa exige `topology.layout`, e assim por diante.

No front, os botões declaram a ação exigida no próprio HTML
(`data-action="topology.edit pops.order"`) e `NOC.applyActions()` aplica o
perfil de uma vez só.

### Perfis editáveis

Em **Perfis e ações** é possível criar, renomear, descrever, duplicar e excluir
perfis, além de marcar telas e ações por módulo. O perfil `administrador` é
protegido: não pode ser renomeado nem excluído e mantém acesso total (o Worker
reaplica todas as ações e telas a ele em cada inicialização).

Os acessos padrão dos perfis são semeados **uma única vez** (registrado em
`platform_meta`): o que o administrador desmarcar não volta em um novo deploy.
Perfis criados fora do catálogo recebem as ações novas equivalentes ao que já
podiam fazer (`ACTION_EQUIVALENCE`), também uma única vez.

### Enlaces derivados e projeção na topologia

As descrições de interface (`ifAlias`) documentam a ponta remota de cada enlace.
`src/zabbix-links.js` lê essas descrições e deriva os enlaces físicos em dois
níveis de confiança:

- **alta** — as duas pontas citam a interface da outra (confirmação mútua);
- **media** — só um lado cita, e a interface remota é única e compatível.

Referência ambígua, ou que aponta para uma localidade onde nenhum candidato
existe, é descartada: a ponta remota provavelmente não é monitorada. A derivação
exige a mesma família de velocidade nas duas pontas — sem isso um `100GE0/0/2`
casaria com um `XGigabitEthernet0/0/2` só porque ambos citam "0/0/2".

`src/zabbix-topology.js` projeta esse resultado na topologia editável:

- as portas dos equipamentos monitorados passam a ter o **nome real da
  interface**, a velocidade e a descrição vindas do SNMP. O `numero` continua
  sendo a chave das telas e das conexões, e as portas livres já cadastradas são
  mantidas — sem isso a ocupação de todo equipamento passaria a marcar 100%;
- os enlaces entre equipamentos monitorados vêm da derivação;
- equipamento que o Zabbix não monitora (o DWDM Nokia e o concentrador de
  Cubatão) **não é tocado**: as portas dele e as conexões que só envolvem ele
  são preservadas, e os enlaces até ele são reconstruídos a partir do que o
  alias do lado monitorado declara (`EXTERNAL_PEERS`);
- uma porta nunca fica em duas conexões: o registro recusa a segunda e a
  reporta em `relatorio.conexoes.conflitos`.

A ordem de precedência é: enlace derivado do monitoramento, depois conexão
manual entre equipamentos não monitorados, e por último a inferência por texto —
a inferência mais fraca não derruba o que foi documentado à mão.

```bash
node backend/scripts/zabbix-apply-topology.mjs
```

Sem `--apply` é só ensaio: mostra portas, enlaces derivados, preservados,
substituídos e conflitos, sem gravar. Com `--apply` grava e registra em
`audit_logs` com o estado anterior em `before_json` (é o ponto de reversão).
Pela aplicação, o mesmo está em `POST /api/zabbix/topology/apply`, que exige
`topology.link.create` e `topology.port.edit` — e `topology.link.delete` quando
a projeção substitui enlaces já documentados.

### Tela de Tráfego

`/trafego.html` (tela `trafego`, ação `zabbix.view`) é o painel de monitoramento
de tráfego. A utilização usa o sentido mais carregado, que é como a operação
enxerga saturação.

Leitura acima da capacidade nominal da porta é **descartada dos totais** e
marcada como inconsistente: é falha de coleta, não saturação. As portas GPON da
OLT C300 chegam a reportar 1,8 Tbps numa porta de 2,488 Gbps — 18 interfaces
assim inflavam o total em 17 Tbps.

#### Organização

Uma faixa de estado fica **acima das guias** e nunca é escondida: leitura,
entrada/saída, pico de utilização, interfaces no ar, enlaces e erros. Saturação
e enlace caído não podem depender de a pessoa estar na guia certa para aparecer.

| Guia | O que mostra | Endereço direto |
| --- | --- | --- |
| Visão geral | Indicadores, curva do período, maiores consumidores e o que precisa de atenção | `/trafego.html#visao` |
| Enlaces | Pares confirmados pela descrição, com edição da documentação na topologia | `#enlaces` |
| Interfaces | Tabela completa, filtros, densidade, tendência e exportação CSV | `#interfaces` |
| Equipamentos | Tráfego somado por host, com o vínculo host ↔ equipamento | `#equipamentos` |
| Alertas | Fora do ar, saturação e leitura duvidosa, na ordem em que a operação trata | `#alertas` |
| Ajustes | Limites, período, rotação do telão e apelidos de interface | `#ajustes` |

Atalhos: `←` `→` percorrem as guias, `V` liga o modo telão, `Esc` sai dele.

#### Modo telão (55")

`V`, o botão **Modo TV** ou `/trafego.html?tv=1`. O cromo some, a tipografia é
multiplicada por uma única variável (`--traf-zoom`) e os painéis escolhidos
giram sozinhos, com um trilho no rodapé mostrando em qual deles a tela está.
`←` `→` trocam de painel à mão e a barra de espaço pausa a rotação.

A escala padrão (100%) é calibrada para 55" a ~4 m: o número principal fica em
80 px, cerca de 5 cm na tela. Telas maiores ou mais distantes sobem o valor em
**Ajustes → Modo telão**, sem tocar no CSS.

#### O que é editável, e por quem

| O quê | Onde | Ação exigida |
| --- | --- | --- |
| Tipo, capacidade e observação do enlace | Guia Enlaces → Editar | `topology.edit` + `topology.link.create` |
| Vínculo host do Zabbix ↔ equipamento | Guia Equipamentos → Vínculo | `zabbix.link` |
| Apelido, observação, marca “crítica” e “fora dos totais” da interface | Guia Interfaces → lápis | `trafego.settings` |
| Limites de atenção e crítico, tolerância de leitura | Guia Ajustes | `trafego.settings` |
| Intervalo de recarga, janela do gráfico, tamanho do topo | Guia Ajustes | `trafego.settings` |
| Título, escala, rotação e painéis do telão | Guia Ajustes | `trafego.settings` |
| Projetar os enlaces do Zabbix na topologia | Guia Enlaces | `topology.link.create` + `topology.port.edit` |

Sem a ação, o controle aparece **desabilitado com o motivo no `title`** — não
escondido e não deixando o erro chegar depois do clique. Quem só tem
`zabbix.view` vê os Ajustes em leitura, com o aviso de qual ação falta.

Os ajustes ficam em `platform_meta` (chave `trafego.settings`), não na
topologia: são configuração de tela e não têm por que arrastar os ~50 KB da
topologia a cada gravação. Toda alteração passa por `TRAFEGO_SETTINGS_UPDATE`
na auditoria, com estado anterior e posterior. O servidor normaliza cada campo
dentro de um intervalo válido — limite crítico abaixo do de atenção é empurrado
para cima, e nada do que o cliente manda é gravado como veio.

Perfis que já podiam alterar a topologia recebem `trafego.settings` uma única
vez, por `seed.trafego_settings.v1`. Depois disso vale o que o administrador
marcar em **Plataforma → Perfis**.

#### Abertura da tela

A tela abria em cinco idas ao servidor **em fila**: `/api/auth/me`, `/api/access`,
`/api/access` de novo (o `noc-api.js` repetia o pedido do guardião),
`/api/topology` e só então as três chamadas do Zabbix. Agora:

- `auth-guard.js` pede sessão e acesso **em paralelo** e publica a Promise em
  `window.UPDOWN_ACCESS_PROMISE`, que o `NOC.loadAccess()` reaproveita — a
  terceira requisição deixou de existir;
- um script no `<head>` dispara `/api/zabbix/overview` **antes** de os três
  arquivos JS terminarem de baixar, tirando o download do caminho crítico;
- `/api/topology` sai do caminho crítico: sobe em segundo plano
  (`requestIdleCallback`) porque só serve para editar a documentação dos
  enlaces e vincular host a equipamento. Quem só monitora não paga por ela.

Medido no ambiente local, a cadeia de dados da abertura caiu de **531 ms para
44 ms**; as três requisições que restam partem juntas, aos ~120 ms.
