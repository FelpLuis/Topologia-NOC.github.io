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
- `public/isp.html`, `public/isp-mapa.html`, `public/isp-cadastro.html`: as três telas da **PARTE ISP**.
- `public/js/noc-fibra.js`: camada de caminhos de fibra do mapa ISP.
- `public/js/noc-isp-cadastro.js`: cadastro de ISPs e dos equipamentos deles.
- `public/data/isp-*.json`: sementes da PARTE ISP, geradas do KMZ do backbone.
- `backend/scripts/kmz-import.mjs`: importador do KMZ para essas sementes.
- `src/worker.js`: API do sistema e intermediária entre a página e o Zabbix.
- `src/turso-d1.js`: adaptador que mantém a API de consultas do Worker sobre o Turso.
- `src/zabbix.js`, `src/zabbix-links.js`, `src/zabbix-topology.js`: integração Zabbix.
- `wrangler.jsonc`: configuração do Worker.

## Banco Turso

O banco de produção é o `updown` no Turso. O Worker usa o cliente HTTP oficial
e recebe as credenciais por Secrets da Cloudflare:

```text
TURSO_DATABASE_URL=libsql://updown-felpluis.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=<token de leitura e escrita>
```

O arquivo local `.env.production` possui essas duas entradas e está ignorado
pelo Git. Para cadastrar ou atualizar os Secrets sem expor os valores:

```bash
npx wrangler secret bulk .env.production
```

O `wrangler.jsonc` posiciona o código do Worker próximo à região
`aws:us-east-1`, onde está o banco, e não declara mais binding D1.

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

### Importação gratuita da agenda pessoal

Cada usuário autenticado abre **Importar agenda (.ics)** e seleciona o arquivo
exportado de sua agenda pessoal. No Gmail, abra a Agenda e use **Configurações →
Importar e exportar → Exportar**; depois, extraia do arquivo `.zip` os calendários
`.ics` e selecione todos os desejados de uma só vez. A importação não usa Google Cloud, OAuth, credenciais pagas, assinatura
ou período de teste. Os alertas em popup ficam configurados para 10 minutos
antes do compromisso. Se o usuário autorizar, o navegador também exibe uma
notificação do sistema.

A tela **Agenda** reúne a agenda pessoal do usuário e uma agenda para cada setor
ao qual ele pertence. Os setores são cadastrados em **Gerenciar plataforma →
Setores** e funcionam como grupos de autorização: no cadastro ou na edição de
um usuário, marque um ou mais setores. Compromissos setoriais ficam visíveis
somente aos membros e ficam armazenados no NOC. Todo setor cadastrado já possui
uma agenda, mesmo que ainda esteja vazia. A agenda pessoal importada é
somente leitura e cada compromisso interno pode ativar um alerta em popup.

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


## MIGRAÇÃO D1 PARA TURSO

O `wrangler.jsonc` não declara mais o binding D1. As consultas existentes são
encaminhadas ao Turso por `src/turso-d1.js`, preservando `prepare`, `bind`,
`first`, `all`, `run` e `batch` usados pelo Worker.

O projeto também não usa mais `better-sqlite3`, `express` ou `cookie-parser` no deploy do Worker.

### Teste

Depois do deploy, abra:

`/api/health`

O resultado esperado é:

```json
{"ok":true,"service":"topologia-noc","dependencies":{"database":"ok"}}
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

### Mapa geográfico (OpenStreetMap)

A tela de topologia tem três modos, no seletor da barra superior:

| Modo | O que mostra |
| --- | --- |
| **Esquema** | o mapa de sempre, com as caixas posicionadas à mão (`config.layout`) |
| **Mapa OSM** | os mesmos POPs, equipamentos e enlaces sobre o mapa do OpenStreetMap |
| **Lista** | tabela de equipamentos |

O modo escolhido fica lembrado por navegador (`localStorage`).

O POP ganhou os campos opcionais `lat`, `lon` e `endereco`, gravados no próprio
cadastro do POP dentro da topologia — portanto passam pelo mesmo `PUT /api/topology`,
pela mesma auditoria e pela mesma ação `pops.edit`. Sem coordenada, o POP continua
inteiro no modo Esquema e aparece na lista "fora do mapa" no modo Mapa OSM.

O mapa abre sempre na mesma vista de trabalho: a Baixada Santista a partir de Cubatão
(-23.896750, -46.433127) no **nível 12**, definida em `VISTA_PADRAO`. É o enquadramento
em que a rede inteira cabe com as ruas ainda legíveis, e é o apoio para posicionar um POP
que ainda não tem coordenada. O botão **ajustar à tela** recentraliza nos POPs já
localizados, mas nunca aproxima mais que esse nível — dois POPs vizinhos jogariam o mapa
para a escala de quarteirão.

No mapa geográfico o POP é um **alfinete**, não o card: a cor acompanha a ocupação e o
número é a quantidade de equipamentos. O card só abre no clique, um de cada vez, e
fecha no × ou clicando no mapa vazio — cinco cards abertos cobririam cinco cidades.
No modo Esquema nada muda: lá o card aparece direto, como sempre.

Há dois caminhos para cadastrar a localização:

- **Gerenciar rede → POPs → Editar**: nome, endereço, rotas e latitude/longitude,
  com um campo que aceita o par colado de um mapa (`-23.960833, -46.333611`);
- **Definir localização** (o botão de layout no modo Mapa OSM): arraste o alfinete até
  o ponto dele e salve — o arrasto vira latitude e longitude. POP ainda sem coordenada
  aparece na lista "fora do mapa" com o botão **Colocar aqui**, que o solta no centro da
  vista para então ser arrastado.

## PARTE ISP — topologia e mapa de fibra

A PARTE ISP é um **segundo recorte da topologia**, com o mesmo formato de documento e as
mesmas regras de edição e auditoria da rede NOC, mas com dados próprios: os clientes ISP
entram como POPs e o caminho físico da fibra vira um cadastro à parte. No menu lateral ela
tem um grupo só dela, com duas telas:

| Tela | Rota | O que faz |
| --- | --- | --- |
| **Topologia ISP** | `/isp.html` | igual à topologia do NOC — Esquema, Mapa OSM e Lista, equipamentos, portas e enlaces, só que sobre os clientes ISP |
| **Mapa de fibra ISP** | `/isp-mapa.html` | o mesmo mapa geográfico, mais os caminhos de fibra e as caixas ópticas |
| **Cadastro de ISP** | `/isp-cadastro.html` | criar, editar e **excluir** o cliente e os equipamentos dele, em um lugar só |

### O recorte no servidor

`GET`/`PUT /api/topology?scope=isp` lê e grava a PARTE ISP. Sem o parâmetro, tudo continua
indo para a rede NOC exatamente como antes.

A tabela `topology_state` nasceu com `CHECK(id=1)` e continua sendo a da rede NOC. Os
recortes adicionais vivem em **`topology_scopes`** (migração `0010_topology_scopes.sql`),
uma linha por recorte, com o mesmo controle de versão. A tela declara o recorte em
`<body data-scope="isp">`; o `noc-api.js` acrescenta o `?scope=` sozinho a partir daí.

Além de `equipamentos`, `conexoes`, `pops` e `config`, o documento do recorte ISP tem mais
duas listas:

- **`fibras`** — as polilinhas: `{ id, nome, tipo, fibras, cor, observacao, extensao, pontos: [[lat, lon], …] }`;
- **`caixas`** — os pontos do caminho: `{ id, nome, tipo, observacao, lat, lon }`.

O Worker só aceita essas listas no recorte que as declara, e **omiti-las preserva o que já
estava gravado** — assim uma tela que não conhece o campo nunca apaga o cadastro da outra.

### Ações

Duas ações novas, no catálogo de Plataforma → Perfis, ligadas à tela `isp-mapa`:

| Ação | Permite |
| --- | --- |
| `fibra.edit` | criar e alterar cabos, traçados e caixas ópticas |
| `fibra.delete` | remover cabos, traçados e caixas ópticas |

Como em toda gravação da topologia, `topology.edit` continua sendo a base para escrever e
`topology.delete` para remover. Na primeira implantação os perfis que já abriam a topologia
principal recebem as duas telas, e quem já podia mexer nas rotas do anel (`pops.routes`)
recebe `fibra.edit` — depois disso o administrador ajusta normalmente em Perfis e ações.

### Importar o KMZ do backbone

As sementes de `public/data/isp-*.json` saem de um KMZ exportado do Google Earth Pro:

```bash
npm run import:kmz -- "C:/caminho/BACKBONE UPDOWN 16 07 2025.kmz"
```

A classificação é por nome do marcador:

| No KMZ | Vira |
| --- | --- |
| `LineString` (cabo, traçado, `Medida do caminho`, `AS 80`, cordoalha) | caminho de fibra, com a cor original da linha e a extensão calculada |
| ponto `ceo…`, `RT.`, `SUB.`, `TRA`, `cx`, `poste`, número solto | caixa óptica |
| ponto que começa com `POP` | POP próprio |
| qualquer outro ponto nomeado | **cliente ISP**, cadastrado como POP |

O KMZ de 16/07/2025 rendeu **19 clientes ISP, 5 POPs próprios, 219 caixas e 58 caminhos de
fibra somando 119,57 km**. A importação é só a semente: a partir da primeira abertura da
tela quem manda é o D1, e o `npm run import:kmz` **não** volta a sobrescrever o que já foi
editado na interface — ele só regrava os arquivos de `public/data/`.

### Editar o mapa de fibra

Tudo é editável na tela, com o mesmo padrão de aviso, desfazer e auditoria do resto do NOC:

- **clicar num cabo** abre a ficha com tipo, quantidade de fibras, extensão, pontos e
  observação, e os botões de enquadrar, editar cadastro, editar traçado e excluir;
- **Editar traçado** põe uma alça em cada vértice: arraste para mover, clique no **+** do
  meio do segmento para inserir um ponto e use o **botão direito** para remover;
- **Nova fibra** desenha um caminho clicando ponto a ponto no mapa — duplo clique ou
  **Enter** conclui e abre o cadastro, **Esc** desiste;
- **Nova caixa** marca uma CEO, reserva técnica ou poste no ponto clicado;
- o painel lateral filtra por texto e por tipo, liga e desliga as camadas de fibra e de
  caixas, e mostra a quilometragem do que está em exibição.

A localização dos clientes ISP é editada como a de qualquer POP: pelo cadastro ou
arrastando o alfinete em **Definir localização**.

### Cadastro de ISP

A tela de POPs edita o POP e vincula equipamento, mas **não cria nem exclui** — criar um
POP mora dentro de um modal da topologia e excluir não existe em tela nenhuma. O
**Cadastro de ISP** fecha esse ciclo para a PARTE ISP, com o cliente e os equipamentos
dele na mesma tela:

| Ação | Exige |
| --- | --- |
| **Novo ISP** — nome, tipo, endereço, localização, rotas e observação | `topology.edit` + `pops.create` |
| **Editar** o ISP | `topology.edit` + `pops.edit` |
| **Excluir** o ISP | `topology.delete` + `pops.delete` |
| **Novo equipamento** já vinculado ao ISP, com as portas | `topology.edit` + `topology.equipment.create` |
| **Editar** o equipamento (inclusive trocar de ISP e a quantidade de portas) | `topology.edit` + `topology.equipment.edit` |
| **Excluir** o equipamento | `topology.delete` + `topology.equipment.delete` |
| **Vincular existente** / **Desvincular** | `topology.edit` + `topology.pop.link` |

O campo **Tipo** separa `Cliente ISP` de `POP` (e aceita Parceiro, Operadora e Cliente
corporativo), e vira filtro na lista junto com a busca por nome, identificador ou endereço.

Três cuidados que a tela toma sozinha:

- **Excluir um ISP que tem equipamento** não escolhe por você: o diálogo oferece
  *Excluir só o ISP* (os equipamentos ficam sem vínculo, com os enlaces preservados) e
  *Excluir ISP e equipamentos* (leva junto os enlaces documentados neles);
- **Excluir um equipamento** remove também os enlaces documentados nele — deixá-los para
  trás criaria conexão apontando para equipamento que não existe mais;
- **Reduzir a quantidade de portas** nunca apaga porta com enlace: o equipamento fica com
  a última porta ocupada e um aviso diz o que não coube.

Toda operação tem **Desfazer** no aviso que aparece depois de salvar, e o painel lateral
alerta sobre equipamento sem ISP (com atalho para vincular ou excluir) e sobre ISP sem
localização, que é o que o deixa fora do mapa de fibra.

### Cor de estado no mapa

A linha de enlace é pintada pelo `operStatus` das interfaces sincronizadas do Zabbix
(1 = up, 2 = down), o mesmo dado que alimenta o status dos equipamentos:

| Linha | Significado |
| --- | --- |
| **verde** | as pontas monitoradas do enlace estão no ar |
| **âmbar** | parte do feixe caiu (ex.: 1 de 3 enlaces do caminho) |
| **vermelho** | todos os enlaces do caminho estão fora do ar |
| cinza | nenhuma ponta monitorada — a cor não afirma o que não foi medido |

A animação de tráfego some das linhas vermelhas: fluxo correndo sobre um enlace caído
seria a informação errada. As rotas do anel (tracejado roxo) não recebem cor — elas vêm
do cadastro de rotas do POP, não do Zabbix.

O POP segue o pior estado entre os equipamentos que o Zabbix monitora: **verde** no ar,
**âmbar** com parte fora, e **vermelho piscando** quando todos os equipamentos dele
caíram — no alfinete do mapa e no card. Quem pediu menos movimento
(`prefers-reduced-motion`) recebe o vermelho fixo, sem piscar.

Não há biblioteca de mapa de terceiros: `public/js/noc-geo.js` implementa a projeção
Web Mercator e a camada de tiles em ~180 linhas, porque o CSP do Worker só libera
script próprio (`script-src 'self'`) e porque os tiles precisam viver dentro do
mesmo `transform` de zoom/pan que as caixas dos POPs. O CSP libera apenas as
**imagens** de `tile.openstreetmap.org` (`img-src`). O zoom do mapa anda de um nível
inteiro por vez, para o tile ser sempre desenhado em 256 px, e as caixas dos POPs
mantêm o tamanho na tela, como marcadores. A atribuição do OpenStreetMap fica no
canto do mapa, como exige a licença ODbL.

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

Com `realtime=1`, o mesmo endpoint consulta o Zabbix antes de responder e entrega
as métricas atuais diretamente ao painel. A leitura fica por poucos segundos no
cache da borda para que vários telões no mesmo local não repitam a mesma consulta.
Ela não regrava todas as interfaces no D1; o espelho persistente e o histórico
continuam sob responsabilidade do cron.

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
`NOC.formatBps()` e `NOC.interfaceStatus()` para exibição. Com “Atualizar sozinho”
ativado, o painel solicita uma coleta atual do Zabbix no intervalo configurado
(15 segundos por padrão). Se a coleta falhar, a tela continua disponível com o
último espelho persistido e marca a leitura como atrasada.


## Coleta GPON (ONT + IXC) e histórico auditável

A tela `/gpon` mostra o estado de cada ONU do parque com atualização de **10
segundos** e guarda no banco a linha do tempo de tudo que mudou.

### Os três ritmos do coletor

`collector/server.mjs` roda dentro da rede das OLTs e mantém três ciclos, porque
os dados têm custos e velocidades muito diferentes:

| Ciclo | Intervalo | O que traz | Variável |
| --- | --- | --- | --- |
| Completo | 10 min | Cadastro do IXC (clientes, contratos, caixas, coordenadas) + `baseinfo` das PONs (serial, modelo) | `IXC_REFRESH_INTERVAL_MS` |
| ONT | 10 s | `show gpon onu state` em cada OLT — se a ONU está acesa na fibra | `COLLECTOR_INTERVAL_MS` |
| Radius | 10 s | `radusuarios` do IXC — se o cliente autenticou | `COLLECTOR_INTERVAL_MS` |

Os dois ciclos rápidos correm **em paralelo e independentes**: cada um pula a vez
enquanto o anterior não terminou, então uma OLT lenta se auto-regula sem atrasar
a leitura do Radius. O intervalo é o piso, não uma promessa — se o
`show gpon onu state` de uma OLT grande levar 25 s, o ciclo dela passa a ser de
25 s, e `/health` no coletor reporta `ont_cycle_ms` e `radius_cycle_ms` para que
isso seja visível em vez de suposto.

A sessão SSH/Telnet com cada OLT fica **aberta entre os ciclos**
(`withZteSession` em `collector/zte-cli.mjs`). Abrir, autenticar e mandar
`terminal length 0` custa alguns segundos — aceitável a cada dez minutos,
proibitivo a cada dez. Qualquer falha derruba a sessão e o ciclo seguinte
reconecta.

`ONT_FAST_ENABLED=0` desliga só a leitura rápida na OLT, para parques em que
consultar o equipamento de produção a cada 10 s não é aceitável. O estado
continua vindo do Radius em 10 s e da OLT no ciclo completo.

### Como as duas fontes viram um estado só

A ONU acesa e o cliente autenticado são perguntas diferentes, e o operador
precisa das duas na mesma linha (`combinarEstado`):

| ONT | Radius | Estado exibido | Detalhe |
| --- | --- | --- | --- |
| fora de `working` | qualquer | o próprio estado da OLT (`los`, `dyinggasp`…) | `ONU LOS` |
| `working` | offline | `offline` | `ONU ativa • Radius offline` |
| `working` | online | `online` | `ONU working • Radius online` |

O detalhe é o que decide se o chamado é de campo ou de provisionamento.

### O que fica no banco

Duas tabelas novas (`migrations/0019_gpon_history.sql`), as duas append-only:

- **`gpon_status_history`** — uma linha por *transição*: estado anterior ao lado
  do novo, RX de antes e de agora, origem que observou (`ont`, `ixc`,
  `snapshot`), identidade da ONU (OLT, índice, serial, cliente) e o ciclo que a
  trouxe. Repetição do mesmo estado não vira evento, e o RX só entra quando varia
  2 dB ou mais — sem isso a oscilação normal do sinal afogaria as quedas reais.
- **`gpon_sync_runs`** — uma linha por *ciclo recebido*, inclusive os que não
  mudaram nada, com contagem, defasagem (`lag_ms`) e IP de origem. Um buraco
  nesta lista é a prova de que a coleta parou: o histórico de transições,
  sozinho, não distingue “a rede está estável” de “ninguém olhou”.

O snapshot (`gpon_snapshot_*`) continua sendo sobrescrito — ele responde “como
está agora”. As duas tabelas acima respondem “quando mudou, de quê para quê e
quem observou”.

A poda roda no cron do Worker, independente do Zabbix estar configurado:

```
GPON_HISTORY_RETENTION_DAYS=90
GPON_RUNS_RETENTION_DAYS=30
```

### Rotas

| Rota | Método | Quem pode | Para quê |
| --- | --- | --- | --- |
| `/api/gpon/ingest` | POST | `GPON_SYNC_TOKEN` | Fotografia completa do parque |
| `/api/gpon/status` | POST | `GPON_SYNC_TOKEN` | Delta de estado do ciclo de 10 s |
| `/api/gpon/status` | GET | `topology.view` | Estado atual sem o cadastro junto |
| `/api/gpon/revision` | GET | `topology.view` | Versão do snapshot + batimento da coleta |
| `/api/gpon/history` | GET | `topology.view` | Linha do tempo (`client_id`, `limit`, `since`, `event`) |
| `/api/gpon/sync-runs` | GET | `audit.view` | Auditoria dos ciclos de coleta |

### Como a tela acompanha 10 segundos

`public/js/noc-gpon-map.js` consulta `/api/gpon/revision` a cada 10 s e decide:

- **versão mudou** → cadastro novo, relê o snapshot inteiro (`/api/gpon/clients`);
- **só o `synced_at` mudou** → estado novo, busca `/api/gpon/status` e aplica o
  delta sobre os clientes já indexados, sem reprojetar coordenada nem refazer
  índice. É a resposta comum do ciclo, e é o que torna 10 s sustentável: baixar
  megabytes de nome e endereço para descobrir que três ONUs caíram era o que
  impedia a tela de acompanhar a coleta nesse ritmo;
- **nada mudou** → só atualiza o relógio do cabeçalho.

Um ciclo sem nenhuma transição move o `updated_at` (batimento) e **não** o
`synced_at`, então a tela distingue “a rede está calma há meia hora” de “a coleta
morreu”. O cabeçalho mostra a alteração mais recente, e o `title` traz os dois
instantes.

Clicar num cliente abre, junto da ficha, o **histórico do estado** daquela ONU —
as últimas 25 transições, buscadas sob demanda.


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
| Nome exibido, descrição, observação, marca “crítica” e “fora dos totais” da interface | Guia Interfaces → lápis | `trafego.settings` |
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

---

## Chat WhatsApp (atendimento por setor)

A tela `/whatsapp.html` (tela `whatsapp`) é o atendimento ao cliente pelo
WhatsApp, usando a **WhatsApp Cloud API da Meta** (o mesmo padrão do módulo OPA
Suite da IXC). O número é único: quando um cliente chama, o bot responde com um
menu de setores e a conversa é roteada para o setor escolhido.

### Como funciona

- **Bot de roteamento** — a primeira mensagem do cliente recebe a saudação e o
  menu numerado dos setores habilitados. A resposta do cliente (número ou nome
  do setor) direciona a conversa para a fila do setor. Sem reconhecimento, o
  bot reenvia o menu (até 3 tentativas).
- **Fila e atendimento** — conversas roteadas entram na fila do setor. Qualquer
  usuário com `whatsapp.chat` **Pega** a conversa e assume o atendimento;
  enquanto estiver em uma conversa aberta, o usuário aparece como **em
  conversa** para o resto do setor. Ao **Encerrar**, volta a ficar **disponível**.
- **Presença** — a coluna Equipe mostra os atendentes do setor com o status:
  disponível, em conversa ou pausado. Quem tem a ação `whatsapp.supervise`
  também enxerga **com quem** cada colega está conversando e pode clicar para
  abrir a conversa; os demais veem apenas o status. O próprio atendente pode se
  pausar pelo botão da coluna.
- **Supervisão** — a ação `whatsapp.supervise` permite **Atribuir** uma conversa
  para outro setor e/ou responsável. Sem ela, um atendente só atende conversas
  dos próprios setores.
- **Novo contato** — usuários com `whatsapp.chat` podem iniciar uma conversa
  proativa: número, nome (opcional), setor e a primeira mensagem.

### Ações

| Ação | Permite |
| --- | --- |
| `whatsapp.view` | Ver conversas, fila de roteamento e status dos colegas |
| `whatsapp.chat` | Pegar conversas, responder e encerrar atendimentos |
| `whatsapp.supervise` | Ver com quem cada colega conversa e atribuir conversas |
| `whatsapp.manage` | Editar saudação, menu de setores e mensagens do bot |

Na primeira implantação, `whatsapp.view` e `whatsapp.chat` entram para os perfis
operacionais; `whatsapp.supervise` e `whatsapp.manage` ficam com
`administrador` e `gerente`. Depois, vale o que for marcado em Plataforma →
Perfis.

### Configuração (Cloudflare Secrets)

```bash
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
```

- `WHATSAPP_ACCESS_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` — token e número da WABA
  para **enviar** mensagens pela Graph API (`/v21.0/{phone-number-id}/messages`);
- `WHATSAPP_VERIFY_TOKEN` — token de verificação do webhook (deve ser igual ao
  cadastrado na Meta);
- `WHATSAPP_APP_SECRET` — segredo do app da Meta, usado para validar a assinatura
  `X-Hub-Signature-256` dos eventos recebidos. Sem ele o webhook aceita eventos
  sem validação (uso apenas em desenvolvimento).

Cadastre na Meta o webhook:

```text
https://SEU-DOMINIO/api/whatsapp/webhook
```

com evento `messages`. A verificação do webhook (`GET`) responde ao desafio
`hub.challenge` quando `hub.verify_token` confere; os eventos (`POST`) validam a
assinatura, gravam a mensagem, atualizam a conversa e disparam o bot.

As mensagens ficam em `wa_conversations` e `wa_messages`, a presença em
`wa_agent_presence`. Se os Secrets do WhatsApp não estiverem configurados, o
webhook continua recebendo e registrando mensagens, mas o envio responde
`WHATSAPP_NAO_CONFIGURADO` — nada derruba o serviço.
