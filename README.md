# UPDOWN Telecom — Topologia de Rede

Aplicação web estática para documentação visual da topologia de rede.

## Estrutura

```text
updown-topologia/
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
└── data/
    ├── equipamentos.json
    └── conexoes.json
```

## Como publicar no GitHub Pages

1. Crie um repositório no GitHub.
2. Envie todos os arquivos mantendo a estrutura das pastas.
3. Entre em **Settings → Pages**.
4. Em **Build and deployment**, selecione:
   - Source: **Deploy from a branch**
   - Branch: **main**
   - Folder: **/ (root)**
5. Salve.
6. O GitHub fornecerá o endereço do site.

## Como editar a topologia

A interface está separada dos dados.

### Equipamentos

Edite:

```text
data/equipamentos.json
```

Cada equipamento possui:

- `id`
- `nome`
- `modelo`
- `categoria`
- `local`
- `observacao`
- `portas`

Exemplo:

```json
{
  "numero": 1,
  "capacidade": "10 Gbps",
  "tipo": "SFP+",
  "status": "conectada"
}
```

### Conexões

Edite:

```text
data/conexoes.json
```

Exemplo:

```json
{
  "origem": "santos",
  "portaOrigem": 1,
  "destino": "m8",
  "portaDestino": 48,
  "capacidade": "A confirmar",
  "tipo": "BGP/MPLS"
}
```

Depois de alterar os arquivos no GitHub e fazer o commit, o GitHub Pages publicará a nova versão.

## Importante

O GitHub Pages é uma hospedagem estática. A edição dos dados não grava diretamente no servidor pelo navegador.

Para alterar a documentação de forma permanente, edite os arquivos JSON no GitHub.

Se futuramente for necessário permitir que usuários editem equipamentos/portas diretamente pela interface e salvem as alterações, será necessário adicionar um backend/API ou integração autenticada com o GitHub.

## Observação técnica

As capacidades devem ser conferidas contra o modelo exato e as placas instaladas antes de tratar o documento como inventário físico/as-built.

Onde o modelo Nokia/Datacom não pôde ser identificado na imagem original, a aplicação mantém a capacidade como **A confirmar**.
