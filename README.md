# UPDOWN Topologia NOC — Cloudflare Worker + Static Assets

A aplicação agora usa **Cloudflare Worker + Static Assets**. Isso permite manter o site estático e, ao mesmo tempo, criar uma API segura para consultar o Grafana sem expor o token no navegador.

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
- `public/js/dashboard.js`: dashboard por POP.
- `public/js/grafana.js`: cliente da API interna `/api/grafana/*`.
- `public/data/equipamentos.json`: cadastro dos equipamentos e portas.
- `public/data/conexoes.json`: ligações entre equipamentos.
- `public/data/pops.json`: cadastro dos POPs.
- `public/data/dashboard.json`: dados usados pela Dashboard.
- `src/worker.js`: API intermediária entre a página e o Grafana.
- `wrangler.jsonc`: configuração do Worker.

## 1. Variável do Grafana

No Cloudflare:

**Workers & Pages → topologia-noc → Settings → Variables and Secrets**

Adicione:

### Variable

```text
Nome: GRAFANA_URL
Valor: https://dashboard.lv.network
```

### Secret

Crie um Secret:

```text
Nome: GRAFANA_TOKEN
Valor: SEU_TOKEN_DO_GRAFANA
```

O token deve ser Secret. Nunca coloque o token em `public/js`, `data`, GitHub ou HTML.

## 2. Deploy

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
https://topologia-noc.luis-felipe-f25.workers.dev/api/grafana/health
```

Se o Grafana estiver configurado corretamente, a resposta terá:

```json
{
  "ok": true,
  "grafanaStatus": 200
}
```

Se não estiver configurado, será retornado um erro explicando o problema.

## 4. Endpoint de consulta

A aplicação possui:

```text
POST /api/grafana/query
```

Esse endpoint encaminha a consulta para:

```text
POST https://dashboard.lv.network/api/ds/query
```

O token é inserido pelo Worker e nunca é enviado ao JavaScript do navegador.

Exemplo de payload que futuramente poderá ser enviado:

```json
{
  "queries": [
    {
      "refId": "A",
      "datasourceId": 1,
      "rawSql": "SUA_QUERY",
      "format": "table"
    }
  ]
}
```

O `datasourceId` e a query real dependem do datasource utilizado pelo seu Grafana.

## 5. Dashboard do Grafana

Também existe:

```text
GET /api/grafana/dashboard/:uid
```

Exemplo:

```text
/api/grafana/dashboard/faouCq_nk
```

Isso permite recuperar o JSON do dashboard pelo UID, desde que o token tenha permissão.

## 6. Integração das portas

A aplicação já possui a estrutura necessária para associar:

```text
Equipamento
    ↓
Porta física
    ↓
Interface Grafana
    ↓
Status
    ↓
RX
    ↓
TX
    ↓
Consumo
```

Exemplo futuro:

```json
{
  "porta": 48,
  "interface": "100GE0/1/48",
  "status": "online",
  "rx": 42.7,
  "tx": 38.2,
  "capacidade": "100 Gbps"
}
```

### Importante

A URL do dashboard do Grafana, sozinha, não informa de forma confiável qual datasource/query deve ser utilizada para cada métrica. Para completar essa etapa, obtenha no Grafana:

**Painel → Edit → Inspect → Query**

e identifique:

- datasource;
- query;
- metric;
- labels/variáveis;
- unidade do RX/TX;
- consulta de status.

Não envie tokens ou senhas.

## 7. Dashboard TV

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
- consumo;
- barra de utilização.

Os valores de status e consumo estão preparados para serem substituídos pelos dados do Grafana.

## 8. NE F1A

A visualização 3D usa a frente do equipamento e as portas estão organizadas em:

```text
01 02 03 ... 26 27 28
29 30 31 ... 54 55 56
```

Portas livres possuem destaque visual.

## Segurança

Nunca faça isto:

```javascript
const GRAFANA_TOKEN = "eyJ...";
```

Use sempre:

```text
Cloudflare Secret → GRAFANA_TOKEN
```

O navegador conversa apenas com:

```text
/api/grafana/*
```

e o Worker conversa com o Grafana.

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

```text
Usuário: admin
Senha:   admin
```

**A senha é temporária.** No primeiro login o sistema força a troca para uma senha forte.

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

O usuário inicial `admin` recebe automaticamente o perfil `administrador`.

Perfis antigos da primeira versão (`admin`, `editor`, `viewer`) são migrados automaticamente para `administrador`, `analista` e `atendimento`, respectivamente, quando o script de inicialização é executado.

Permissões disponíveis:

- `topology.view`
- `topology.edit`
- `topology.delete`
- `users.view`
- `users.manage`
- `audit.view`
- `settings.manage`

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

O perfil `administrador` é o único autorizado a administrar perfis, permissões e telas. As alterações são auditadas.


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
| `GET` | `/api/zabbix/health` | `topology.view` |
| `GET` | `/api/zabbix/status` | `topology.view` |
| `GET` | `/api/zabbix/hosts` | `topology.view` |
| `GET` | `/api/zabbix/interfaces` | `topology.view` |
| `POST` | `/api/zabbix/sync` | `topology.edit` |
| `PATCH` | `/api/zabbix/hosts/:hostid` | `topology.edit` |

Filtros de `/api/zabbix/interfaces`: `equipamento`, `hostid`, `status=up|down`,
`conectadas=1` (só as com enlace documentado), `q` (busca em nome e alias) e
`limit`.

No front, `NOC.zabbix` (`public/js/noc-api.js`) cobre todos eles, com
`NOC.formatBps()` e `NOC.interfaceStatus()` para exibição.
