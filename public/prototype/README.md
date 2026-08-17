# Protótipo do novo front — UPDOWN NOC

Versão navegável das telas novas, com **dados fixos** e **sem nenhuma chamada à
API**. Serve para avaliar fluxo, layout e interação sem depender de sessão, D1 ou
Zabbix. Nada é gravado.

Abra `prototype/index.html` (guia com todas as telas) ou vá direto:

| Arquivo | Tela |
|---|---|
| `login.html` | Acesso |
| `nova-senha.html` | Definir nova senha |
| `topologia.html` | Topologia por localidade |
| `pops.html` | POPs e anel óptico |
| `dashboard.html` | Dashboard NOC (modo TV em `?tv=1`) |
| `plataforma.html` | Perfis, usuários, telas e auditoria |
| `design-system.html` | Cores, tipografia, componentes e acessibilidade |

## Como testar em 2 minutos

1. `admin` / `admin` no login → fluxo de troca de senha obrigatória.
2. Na topologia, clique em **ASCENTY** → a localidade expande nos equipamentos e enlaces.
3. Abra um equipamento → aba **Portas** → clique numa porta em uso.
4. **Gerenciar rede → Vínculo com POP** → vincule o **NE8000-M8** e veja o Dashboard mudar.
5. `Ctrl/⌘ + K` para a paleta de comandos, `T` para trocar o tema.

## Dados

`js/mock-data.js` é gerado a partir de `public/data/*.json` (equipamentos,
conexões e POPs reais) e acrescenta campos de monitoramento fictícios — status,
CPU, RX/TX — apenas para mostrar como a tela fica com a integração ativa. A
aplicação real (`/js/noc-*.js`) não usa esses valores: ela lê o inventário do
Zabbix, e equipamento sem host vinculado mostra “aguardando Zabbix”.

## Relação com a aplicação real

O CSS deste protótipo é uma cópia de `public/css/noc/`. Ao evoluir o design
system, altere `public/css/noc/` (fonte da aplicação) e replique aqui, ou remova
o protótipo quando ele já não for necessário.
