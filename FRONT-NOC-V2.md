# Novo front do NOC — UPDOWN TELECOM

Interface refeita sobre a mesma API, o mesmo D1 e o mesmo RBAC. Nenhum endpoint
foi alterado e nenhuma funcionalidade existente foi removida: o editor completo
antigo continua disponível em `/legado.html`.

## 1. Telas

| Rota | O que é | Script |
|---|---|---|
| `/login.html` | Acesso | inline + `js/noc-ui.js` |
| `/change-password.html` | Troca de senha (obrigatória no 1º acesso) | inline + `js/noc-ui.js` |
| `/` | Topologia por localidade (tela principal) | `js/noc-topology.js` |
| `/pops.html` | POPs, anel óptico e vínculos | `js/noc-pops.js` |
| `/dashboard.html` | Dashboard NOC (com modo TV) | `js/noc-dashboard.js` |
| `/trafego.html` | Painel de tráfego em seis guias, com telão de 55" | `js/noc-trafego.js` |
| `/platform.html` | Perfis, permissões, telas, usuários e auditoria | `js/noc-platform.js` |
| `/legado.html` | Editor clássico completo (markup e `js/app.js` originais) | `js/app.js` |

Arquivos de base:

```text
public/
├── css/noc/{tokens,base,components,screens}.css   ← design system
├── css/noc/trafego.css   ← painel de tráfego: gráficos, guias e escala do telão
├── js/noc-ui.js      ← shell, tema, atalhos, paleta de comandos, modais, avisos
├── js/noc-api.js     ← acesso a /api/* e regras de domínio (POP, portas, ocupação)
└── prototype/        ← protótipo navegável com dados fixos (não usa a API)
```

`css/style.css`, `css/uiux-v3.css`, `css/uiux-v4.css` e `js/app.js` continuam no
projeto porque sustentam `/legado.html`.

## 2. Vínculo equipamento → POP

O equipamento passa a ter um campo próprio no cadastro:

```json
{ "id": "santos", "nome": "6730 • POP Santos", "popId": "pop-santos" }
```

Regras:

- um equipamento pertence a **um único POP** (ou a nenhum);
- vincular, trocar e desvincular acontece em **Topologia → Gerenciar rede → Vínculo com POP**, e também na ficha do equipamento e na tela de POPs;
- o `popId` é gravado por `PUT /api/topology`, com auditoria de estado anterior e posterior;
- é esse campo que organiza o **Dashboard NOC**: cada POP soma apenas os equipamentos vinculados a ele;
- equipamento sem vínculo não desaparece — vai para a seção **“Sem POP vinculado”** no mapa e no dashboard, com ação direta para vincular.

Enquanto o `popId` não existir, o sistema mostra uma **sugestão** derivada do
campo `local` (marcada com o selo “sugerido”) e oferece o botão **Confirmar
sugestões**, que grava todos de uma vez. Sugestão nunca é tratada como vínculo
confirmado.

## 3. Mapa em dois níveis

O mapa começa por **localidade**: cada POP é uma caixa com nº de equipamentos,
portas e ocupação. Clicar expande a caixa e mostra os equipamentos e os enlaces
internos; os enlaces entre POPs fechados aparecem agregados (“3 enlaces”), e as
rotas do anel aparecem tracejadas em roxo, lidas do campo `rotas` do POP.

O layout é calculado a cada render — POP novo ou equipamento novo entram no mapa
sem precisar de coordenada fixa. Zoom e deslocamento funcionam com roda do mouse,
arrasto, botões e teclado (`setas`, `+`, `-`, `0`).

## 4. Permissões

A tela lê `GET /api/topology/permissions` e desabilita o que o perfil não pode
fazer, com o motivo no `title` — em vez de esconder o botão ou deixar o erro
aparecer só depois do clique:

- `topology.edit` → gerenciar rede, vincular POP, editar ficha, criar equipamento/POP;
- `topology.delete` → remover equipamento (a API também recusa no servidor);
- administração de perfis, telas e contas continua exclusiva do perfil `administrador`.

## 5. Decisões de UX aplicadas

1. **Uma porta de entrada para buscar** — a busca do topo abre a mesma paleta de comandos do `Ctrl/⌘+K`: equipamento, POP, tela ou ação no mesmo campo.
2. **Desfazer em vez de confirmar** — ações reversíveis salvam direto e oferecem “Desfazer”; só o destrutivo pede confirmação, sempre dizendo o que se perde.
3. **Rollback honesto** — se o `PUT` falhar, o estado local volta ao anterior e o aviso mostra o erro real da API. A tela nunca exibe algo que não foi gravado.
4. **Sem dado inventado** — status, RX e TX vêm do inventário sincronizado do Zabbix; equipamento sem host vinculado mostra “aguardando Zabbix” e a tela explica a origem dos dados.
5. **Estado não depende só de cor** — todo status tem ponto + rótulo (daltonismo).
6. **Teclado e leitor de tela** — foco visível, foco preso em modais/gavetas, `Esc` fecha, avisos em `aria-live`, alvos de toque de 44 px no celular.
7. **Tema claro e escuro** — trocável por `T` ou pelo menu do usuário, com preferência salva.

Atalhos: `Ctrl/⌘+K` paleta · `/` busca · `Ctrl/⌘+B` menu lateral · `T` tema ·
`G` + `T/P/D/A` navegação · `?` lista de atalhos.

## 6. Painel de tráfego

`/trafego.html` é a tela de monitoramento contínuo, e as decisões dela são as de
uma sala de NOC, não as de um relatório:

1. **O estado fica fora das guias** — a faixa com leitura, entrada/saída, pico,
   interfaces no ar, enlaces e erros está acima da barra de guias e nunca some.
   Saturação e enlace caído não podem depender de a pessoa estar na guia certa.
2. **Seis guias, um estado só** — Visão geral, Enlaces, Interfaces,
   Equipamentos, Alertas e Ajustes. Cada bloco do painel é uma função que
   devolve HTML, e tanto as guias quanto o telão compõem a partir dos mesmos
   blocos: o telão nunca mostra número diferente do da tela de trabalho.
3. **Cada guia tem endereço** — `#enlaces`, `#alertas`… dá para deixar uma aba
   fixa em cada monitor. `←` `→` percorrem as guias pelo teclado.
4. **A escala do telão é um número, não um layout** — o modo TV multiplica
   `--traf-zoom` e a tela inteira acompanha. 100% é calibrado para 55" a ~4 m
   (número principal em 80 px, ~5 cm); telas maiores sobem o valor em Ajustes.
5. **O telão diz que está vivo** — o ponto pulsa enquanto a leitura está fresca
   e para de pulsar com o atraso; o trilho no rodapé mostra em qual painel a
   rotação está. Quem entra na sala sabe se a tela travou.
6. **Escala começa em zero** — o gráfico do período nunca trunca o eixo: uma
   variação de 2% parecendo pico é o erro que um telão não pode cometer.
7. **Sem dado inventado, de novo** — leitura acima da capacidade da porta é
   marcada como inconsistente e fica fora dos totais, e a tela diz quantas são.
   Com menos de duas amostras, a curva não é desenhada: linha reta sugeriria
   uma estabilidade que ninguém mediu.
8. **Configurável por quem pode** — limites, período, rotação, escala, apelido
   e criticidade de interface são gravados por `trafego.settings`, com
   auditoria. Sem a ação, o controle aparece desabilitado com o motivo, e os
   Ajustes viram leitura.

## 7. O que ainda vive no editor clássico

`/legado.html` mantém, sem alteração, o que a interface nova ainda não cobre:

- edição de portas uma a uma (capacidade, tipo, status, conexão e porta remota);
- criação e edição de enlaces;
- edição dos equipamentos anotados dentro de cada POP;
- edição dos títulos configuráveis da tela.

O link está no menu lateral (**Ferramentas → Editor clássico**) e no rodapé da
gaveta de cada equipamento.

## 8. Protótipo navegável

`public/prototype/index.html` é a versão de avaliação: mesmas telas, dados fixos
em `prototype/js/mock-data.js` (gerados a partir de `public/data/*.json`), nenhuma
chamada à API e nenhuma gravação. Serve para validar fluxo e visual sem depender
de sessão, D1 ou Zabbix — inclusive a tela `design-system.html`, que documenta
cores, tipografia, componentes e regras de acessibilidade.
