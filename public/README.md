# UPDOWN Telecom — Documentação Interativa da Topologia

Aplicação web estática para documentação visual da infraestrutura de rede da UPDOWN Telecom.

A aplicação foi organizada para separar:

- **Interface visual**
- **Lógica da aplicação**
- **Cadastro dos equipamentos**
- **Cadastro das portas**
- **Cadastro das conexões**

Isso permite atualizar a topologia sem precisar alterar o código principal da página.

---

# 1. Estrutura do projeto

```text
updown-topologia/
│
├── index.html
│
├── css/
│   └── style.css
│
├── js/
│   └── app.js
│
├── data/
│   ├── equipamentos.json
│   └── conexoes.json
│
├── .gitignore
│
└── README.md
```

---

# 2. O que faz cada arquivo?

## `index.html`

É a **estrutura principal da página**.

Ele define:

- Cabeçalho
- Nome da UPDOWN
- Campo de pesquisa
- Menu lateral
- Área da topologia
- Janela de detalhes do equipamento
- Tabela de portas
- Área do anel óptico dos POPs

### IMPORTANTE

Normalmente você **não precisa alterar este arquivo** para cadastrar equipamentos ou portas.

As informações da rede ficam nos arquivos JSON dentro da pasta `data`.

---

# 3. Pasta `css`

## `css/style.css`

É responsável pelo **visual da aplicação**.

Controla:

- Cores
- Fonte
- Tamanho dos equipamentos
- Tabelas
- Botões
- Menu lateral
- Janela de detalhes
- Responsividade para celular
- Fundo da topologia
- Identidade visual

### Quando mexer neste arquivo?

Somente quando quiser alterar o visual.

Por exemplo:

- Cor da UPDOWN
- Tamanho dos equipamentos
- Tamanho da tabela
- Fonte
- Espaçamento
- Layout
- Cores das portas conectadas

Para simplesmente cadastrar uma nova porta, **não mexa no CSS**.

---

# 4. Pasta `js`

## `js/app.js`

É o **cérebro da aplicação**.

Ele:

- Carrega os arquivos JSON
- Monta os equipamentos na tela
- Cria a lista lateral
- Abre a janela de detalhes
- Monta a tabela de portas
- Identifica as conexões entre equipamentos
- Faz a pesquisa
- Permite exportar um backup dos dados

### IMPORTANTE

Também não é necessário alterar este arquivo para cadastrar uma porta.

A aplicação lê automaticamente:

```text
data/equipamentos.json
data/conexoes.json
```

---

# 5. Pasta `data`

Esta é a pasta que você mais vai utilizar para manter a documentação da rede.

Ela contém os dados da infraestrutura.

```text
data/
├── equipamentos.json
└── conexoes.json
```

---

# 6. `data/equipamentos.json`

Este é o principal arquivo para cadastrar:

- Equipamentos
- Modelo
- Categoria
- Local
- Observações
- Portas
- Capacidade de cada porta
- Tipo da interface
- Status da porta

---

# 7. Como cadastrar uma porta

Dentro de cada equipamento existe uma lista chamada:

```json
"portas": []
```

Cada porta possui:

```json
{
  "numero": 1,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "livre"
}
```

Os campos significam:

| Campo | O que significa |
|---|---|
| `numero` | Número físico/lógico da porta |
| `capacidade` | Velocidade/capacidade da porta |
| `tipo` | Tipo da interface/módulo |
| `status` | Situação atual da porta |

---

# 8. Exemplo — porta livre

```json
{
  "numero": 10,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "livre"
}
```

Na tela aparecerá aproximadamente:

| Porta | Capacidade | Tipo | Status |
|---:|---|---|---|
| 10 | 10 Gbps | SFP+ | livre |

---

# 9. Exemplo — porta conectada

```json
{
  "numero": 1,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "conectada"
}
```

A aplicação destacará a porta como uma porta utilizada.

Porém, para informar **qual equipamento está conectado e qual é a porta remota**, a informação deve ser cadastrada também no arquivo:

```text
data/conexoes.json
```

---

# 10. Como cadastrar uma nova porta

Suponha que você tenha um equipamento com a porta 31.

Adicione dentro de `"portas"`:

```json
{
  "numero": 31,
  "capacidade": "100 Gbps",
  "tipo": "QSFP28",
  "status": "livre"
}
```

Se a porta estiver sendo utilizada:

```json
{
  "numero": 31,
  "capacidade": "100 Gbps",
  "tipo": "QSFP28",
  "status": "conectada"
}
```

---

# 11. Como cadastrar um novo equipamento

Dentro de `data/equipamentos.json`, adicione um novo objeto:

```json
{
  "id": "novo-equipamento",
  "nome": "6730 - POP Exemplo",
  "modelo": "Huawei CloudEngine S6730-H24X6C",
  "categoria": "POP",
  "local": "POP Exemplo",
  "observacao": "Equipamento de distribuição.",
  "portas": [
    {
      "numero": 1,
      "capacidade": "10 Gbps",
      "tipo": "SFP+",
      "status": "livre"
    },
    {
      "numero": 2,
      "capacidade": "10 Gbps",
      "tipo": "SFP+",
      "status": "livre"
    }
  ]
}
```

## Regras importantes

O campo:

```json
"id"
```

deve ser **único**.

Não utilize o mesmo ID em dois equipamentos.

Exemplo correto:

```text
santos-6730
sao-vicente-6730
cubatao-6730
praia-grande-6730
```

---

# 12. `data/conexoes.json`

Este arquivo informa **quem está conectado a quem**.

É aqui que você documenta:

```text
Equipamento A
↓
Porta A
↓
Equipamento B
↓
Porta B
```

Exemplo:

```json
{
  "origem": "santos",
  "portaOrigem": 1,
  "destino": "m8",
  "portaDestino": 48,
  "capacidade": "100 Gbps",
  "tipo": "BGP/MPLS"
}
```

Isso significa:

```text
6730 POP Santos
Porta 1
     ↓
NE8000-M8
Porta 48
```

---

# 13. Como documentar uma nova conexão

Exemplo:

```text
6730 POP Santos
porta 1
        ↓
NE8000-M8
porta 48
```

No `conexoes.json`:

```json
{
  "origem": "santos",
  "portaOrigem": 1,
  "destino": "m8",
  "portaDestino": 48,
  "capacidade": "100 Gbps",
  "tipo": "BGP/MPLS"
}
```

### Atenção

O valor de `origem` e `destino` deve ser exatamente igual ao `id` cadastrado em `equipamentos.json`.

---

# 14. Exemplo completo

## Equipamento

```json
{
  "id": "sw-core-01",
  "nome": "CORE 01",
  "modelo": "Huawei S6750",
  "categoria": "Core",
  "local": "Ascenty",
  "observacao": "Switch principal.",
  "portas": [
    {
      "numero": 1,
      "capacidade": "100 Gbps",
      "tipo": "QSFP28",
      "status": "conectada"
    },
    {
      "numero": 2,
      "capacidade": "100 Gbps",
      "tipo": "QSFP28",
      "status": "livre"
    }
  ]
}
```

## Conexão

```json
{
  "origem": "sw-core-01",
  "portaOrigem": 1,
  "destino": "m8",
  "portaDestino": 48,
  "capacidade": "100 Gbps",
  "tipo": "Uplink"
}
```

A aplicação mostrará:

```text
CORE 01
Porta 1
100 Gbps
QSFP28
        ↓
NE8000-M8
Porta 48
100 Gbps
```

---

# 15. Capacidades das portas

Use sempre **Gbps**, e não GB.

Exemplos:

```text
1 Gbps
10 Gbps
25 Gbps
40 Gbps
50 Gbps
100 Gbps
400 Gbps
```

Evite:

```text
10 GB
100 GB
```

Porque **GB (Gigabyte)** representa capacidade de armazenamento, enquanto **Gbps (Gigabits por segundo)** representa velocidade de transmissão.

---

# 16. Exemplo para S6730-H24X6C

Para um S6730-H24X6C, a documentação pode ficar assim:

```json
{
  "numero": 1,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "livre"
}
```

Até:

```json
{
  "numero": 24,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "livre"
}
```

E as portas de maior velocidade:

```json
{
  "numero": 25,
  "capacidade": "40 / 100 Gbps",
  "tipo": "QSFP28",
  "status": "livre"
}
```

até:

```json
{
  "numero": 30,
  "capacidade": "40 / 100 Gbps",
  "tipo": "QSFP28",
  "status": "livre"
}
```

A capacidade efetivamente disponível deve ser conferida conforme o modelo exato, licença e configuração do equipamento.

---

# 17. Exemplo para S6750-H36C

Porta 1:

```json
{
  "numero": 1,
  "capacidade": "40 / 100 Gbps",
  "tipo": "QSFP28",
  "status": "conectada"
}
```

Porta 2:

```json
{
  "numero": 2,
  "capacidade": "40 / 100 Gbps",
  "tipo": "QSFP28",
  "status": "livre"
}
```

E assim sucessivamente até a porta 36.

---

# 18. Portas com capacidade desconhecida

Nunca invente a capacidade de uma porta.

Quando o modelo ou a placa não puder ser identificado:

```json
{
  "numero": 1,
  "capacidade": "A confirmar",
  "tipo": "A confirmar",
  "status": "conectada"
}
```

Depois que o modelo físico for confirmado, basta substituir:

```text
"A confirmar"
```

pela capacidade real.

---

# 19. Ordem recomendada para documentar um equipamento

Ao instalar ou identificar um novo equipamento:

### 1. Cadastre o equipamento

Em:

```text
data/equipamentos.json
```

### 2. Cadastre todas as portas

Informe:

```text
Número
Capacidade
Tipo
Status
```

### 3. Identifique as portas utilizadas

Altere:

```json
"status": "livre"
```

para:

```json
"status": "conectada"
```

### 4. Cadastre as conexões

Em:

```text
data/conexoes.json
```

Informe:

```text
origem
portaOrigem
destino
portaDestino
capacidade
tipo
```

### 5. Faça o commit no GitHub

Depois do commit, o GitHub Pages atualizará a aplicação.

---

# 20. O que NÃO alterar

Para cadastrar equipamentos e portas, normalmente não altere:

```text
index.html
css/style.css
js/app.js
```

Trabalhe principalmente em:

```text
data/equipamentos.json
data/conexoes.json
```

---

# 21. Fluxo de atualização recomendado

```text
IDENTIFICAR EQUIPAMENTO
          ↓
IDENTIFICAR MODELO
          ↓
IDENTIFICAR PLACAS
          ↓
CADASTRAR PORTAS
          ↓
INFORMAR CAPACIDADE
          ↓
IDENTIFICAR PORTAS UTILIZADAS
          ↓
CADASTRAR CONEXÕES
          ↓
CONFERIR TOPOLOGIA
          ↓
COMMIT NO GITHUB
          ↓
GITHUB PAGES ATUALIZA
```

---

# 22. Como publicar no GitHub Pages

1. Crie um repositório no GitHub.

Sugestão:

```text
updown-topologia
```

2. Envie toda a estrutura:

```text
index.html
css/
js/
data/
README.md
.gitignore
```

3. No GitHub, abra:

```text
Settings
    ↓
Pages
```

4. Configure:

```text
Source: Deploy from a branch
Branch: main
Folder: / (root)
```

5. Clique em **Save**.

6. Aguarde a publicação.

O endereço será semelhante a:

```text
https://SEU-USUARIO.github.io/updown-topologia/
```

---

# 23. Controle de alterações

Como a aplicação usa arquivos JSON, o GitHub mantém o histórico de alterações.

Isso permite saber:

- Quem alterou
- Quando alterou
- O que foi alterado
- Qual era o valor anterior

Para uma documentação de infraestrutura, recomenda-se utilizar **Pull Requests** para alterações importantes.

---

# 24. Recomendação de padrão para a UPDOWN

Para manter a documentação organizada, recomendamos utilizar nomes padronizados.

### Equipamentos

```text
CORE-01
CORE-02
AGG-01
AGG-02
POP-SANTOS-01
POP-SV-01
POP-CUBATAO-01
POP-PRAIA-GRANDE-01
```

### Portas

Sempre:

```text
Porta 1
Porta 2
Porta 3
...
```

### Capacidades

Sempre:

```text
1 Gbps
10 Gbps
25 Gbps
40 Gbps
50 Gbps
100 Gbps
400 Gbps
```

### Conexões

Sempre documentar os dois lados:

```text
Equipamento A
Porta A

↓

Equipamento B
Porta B
```

Isso transforma a aplicação em uma documentação de rede consistente e facilita futuras auditorias, troubleshooting e expansão da infraestrutura.

---

# 25. Backup

A interface possui a opção **Exportar dados**, que gera um arquivo JSON de backup.

Mesmo assim, o principal backup continua sendo o próprio GitHub, através do histórico de commits.

---

## Resumo rápido

Se você só precisa cadastrar uma nova porta:

**Abra:**

```text
data/equipamentos.json
```

**Localize o equipamento:**

```json
"nome": "6730 • POP Santos"
```

**Localize:**

```json
"portas": [
```

**Adicione ou altere:**

```json
{
  "numero": 10,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "conectada"
}
```

Se precisar informar para onde essa porta está conectada, abra:

```text
data/conexoes.json
```

e adicione:

```json
{
  "origem": "santos",
  "portaOrigem": 10,
  "destino": "m8",
  "portaDestino": 48,
  "capacidade": "10 Gbps",
  "tipo": "Uplink"
}
```

Depois faça **Commit** no GitHub.

A documentação será atualizada pelo GitHub Pages.


# 26. Visualização das ligações

A área principal da aplicação agora apresenta as conexões como uma **topologia de rede**.

As linhas mostram visualmente:

```text
Equipamento A
     │
     ├── Porta X
     │
     ▼
Equipamento B
     │
     └── Porta Y
```

Cada linha representa uma entrada de `data/conexoes.json`.

Exemplo:

```json
{
  "origem": "santos",
  "portaOrigem": 1,
  "destino": "m8",
  "portaDestino": 48,
  "capacidade": "100 Gbps",
  "tipo": "BGP/MPLS"
}
```

Na topologia será exibido:

```text
6730 • POP Santos ──────── 1 ↔ 48 ──────── NE8000-M8
```

Ao clicar na **linha da conexão**, a aplicação mostra um painel com:

- equipamento de origem;
- porta de origem;
- equipamento de destino;
- porta de destino;
- capacidade;
- tipo do enlace.

Ao clicar no **equipamento**, continua disponível a tabela completa de portas.

## Importante para reproduzir a topologia física

Para documentar corretamente a rede, cada enlace deve possuir uma entrada em `data/conexoes.json`.

A estrutura recomendada é:

```text
ORIGEM
  ↓
PORTA DE ORIGEM
  ↓
TIPO / CAPACIDADE
  ↓
PORTA DE DESTINO
  ↓
DESTINO
```

Dessa forma, a interface consegue desenhar automaticamente as linhas entre os equipamentos.

Se a topologia física for alterada, normalmente basta alterar `data/conexoes.json`; não é necessário modificar `index.html`, `style.css` ou `app.js`.


# 27. Equipamentos por POP

A topologia de anel óptico possui uma área específica para documentar os equipamentos instalados em cada POP.

O arquivo responsável é:

```text
data/pops.json
```

Cada POP possui:

- nome;
- rotas do anel;
- equipamentos instalados;
- modelo;
- observação.

Exemplo:

```json
{
  "id": "pop-santos",
  "nome": "POP SANTOS",
  "rotas": [
    "Aérea → Praia Grande",
    "Aérea → Cubatão"
  ],
  "equipamentos": [
    {
      "nome": "6730 • POP Santos",
      "modelo": "Huawei CloudEngine S6730-H24X6C",
      "observacao": "Equipamento de distribuição."
    }
  ]
}
```

Para adicionar outro aparelho ao POP, acrescente outro objeto dentro de:

```json
"equipamentos": []
```

Exemplo:

```json
{
  "nome": "OLT 01",
  "modelo": "ZTE C350",
  "observacao": "OLT GPON do POP."
}
```

## Importante

Foram cadastrados somente os equipamentos que já estavam identificados com segurança na documentação atual.

Nos POPs onde o equipamento não foi identificado, foi colocado:

```text
A identificar / cadastrar
```

Isso evita inventar equipamentos que não estejam realmente presentes no POP.

Quando você tiver a relação física de equipamentos de Praia Grande ou Cubatão, basta editar:

```text
data/pops.json
```

Não é necessário alterar `index.html`, `style.css` ou `app.js`.


> Correção: o modal dos POPs possui regra específica para permanecer oculto até que um POP seja selecionado.


## Editor de portas

O botão **Editar portas** permite:

1. selecionar o aparelho;
2. listar todas as portas;
3. alterar a capacidade da porta;
4. informar o equipamento conectado;
5. informar a porta remota;
6. informar o tipo/circuito;
7. desconectar uma porta;
8. aplicar as alterações na topologia.

As alterações são feitas na sessão do navegador. Como a aplicação está hospedada como **site estático no Cloudflare Workers**, o navegador não pode gravar diretamente no `data/equipamentos.json` ou `data/conexoes.json` do GitHub.

Ao clicar em **Salvar alterações**, a aplicação baixa os arquivos JSON atualizados. Substitua os arquivos no GitHub e faça o commit para publicar permanentemente.

Se quiser edição persistente diretamente pelo site, a próxima etapa é adicionar autenticação + banco de dados/API.


### Seleção de conexão

No editor de portas, o campo **Conectado a** usa uma lista dos aparelhos cadastrados em `data/equipamentos.json`. Assim você não precisa digitar o ID do equipamento.

O fluxo é:

```text
Aparelho
   ↓
Porta
   ↓
Capacidade
   ↓
Conectado a → [selecionar aparelho]
   ↓
Porta remota
   ↓
Tipo / circuito
```

Ao salvar, a ligação é refletida novamente na topologia visual.


## Painel lateral recolhível

O painel **Equipamentos** agora é dinâmico.

- Clique na seta `‹` para recolher o painel.
- Quando recolhido, a área central fica disponível para visualizar a topologia.
- Clique na seta `›` para expandir novamente.
- A aplicação memoriza a última posição do painel no navegador usando `localStorage`.

Isso permite trabalhar em dois modos:

```text
PAINEL ABERTO
Equipamentos + Topologia

PAINEL RECOLHIDO
Topologia ocupando praticamente toda a tela
```


> Erro corrigido: foi removida a referência antiga ao botão `exportBtn`, que impedia o JavaScript de continuar executando e, consequentemente, deixava a lista de equipamentos vazia e o botão da sidebar sem funcionamento.


## Edição pelo aparelho aberto

O botão global **Editar portas** foi removido.

Agora o fluxo é:

```text
Clique no aparelho
      ↓
Abre a listagem de portas
      ↓
Clique no ícone ✎
      ↓
Edita somente o aparelho que está aberto
```

No editor é possível alterar:

- nome;
- modelo;
- local;
- capacidade de cada porta;
- equipamento conectado;
- porta remota;
- tipo/circuito;
- desconectar uma porta.



## Edição inline

Ao abrir um equipamento, a tabela de portas permanece na mesma janela.

O ícone **✎** ativa o modo de edição diretamente na tabela. Cada linha passa a apresentar campos editáveis para registrar as strings:

- capacidade;
- tipo/circuito;
- status;
- equipamento ou identificação conectada;
- porta remota.

Os botões **Salvar** e **Cancelar** aparecem na própria tela, sem abrir uma segunda janela.

## Dashboard NOC para TV

Foi adicionada a página `dashboard.html`, otimizada para exibição em uma televisão de 55" em resolução 1920×1080.

Acesse:

`/dashboard.html`

### O que o Dashboard mostra

- KPIs de equipamentos, portas, portas conectadas/livres, conexões e POPs;
- visão visual da topologia principal;
- utilização de portas por equipamento;
- resumo operacional;
- inventário dos equipamentos;
- equipamentos cadastrados em cada POP;
- relógio e data;
- atualização automática dos dados.

A página não possui sidebar nem controles de administração, sendo adequada para uma tela dedicada de NOC.

### Fonte dos dados

O Dashboard usa primeiro o `localStorage` da aplicação (`updown-topologia-data`) para refletir as alterações feitas pela interface. Caso não exista cache local, carrega:

- `data/equipamentos.json`
- `data/conexoes.json`
- `data/pops.json`

A atualização automática ocorre a cada 30 segundos.

