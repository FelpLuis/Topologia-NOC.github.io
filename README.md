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

