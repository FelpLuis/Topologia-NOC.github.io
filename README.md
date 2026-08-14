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
    └── pops.json    
```

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

