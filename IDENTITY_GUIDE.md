# Guia de Identidade Visual — UPDOWN NOC

> Referência única para agentes de IA e desenvolvedores. **Não edite tokens diretamente nos componentes** — use as variáveis CSS definidas em `public/css/noc/tokens.css`.

---

## 1. Paleta de Marca

| Token | Hex / Valor | Uso |
|-------|-------------|-----|
| `--brand-500` | `#0b74ff` | Cor principal (botões primários, links ativos, foco) |
| `--brand-400` | `#2f8bff` | Hover/estados mais claros |
| `--brand-600` | `#0a5ed6` | Pressed/estados mais escuros |
| `--cyan-400` | `#1dc9ff` | Acentos secundários, badges info, gradientes |
| `--cyan-300` | `#6adfff` | Texto de links, kickers em tema claro |
| `--purple-400` | `#a56bff` | Uso restrito (destaques especiais) |

**Gradientes oficiais**
```css
--grad-brand:        linear-gradient(135deg, #0b74ff 0%, #1dc9ff 100%);
--grad-brand-soft:   linear-gradient(135deg, rgba(11,116,255,.16), rgba(29,201,255,.10));
```

---

## 2. Cores Semânticas de Estado

| Estado | Token Base | Fundo (12%) | Borda (30%) | Texto |
|--------|------------|-------------|-------------|-------|
| Sucesso | `--ok-500: #2fd6a0` | `--ok-bg` | `--ok-line` | `--ok-text` |
| Aviso | `--warn-500: #ffb020` | `--warn-bg` | `--warn-line` | `--warn-text` |
| Perigo | `--danger-500: #ff5f74` | `--danger-bg` | `--danger-line` | `--danger-text` |
| Info | `--info-500: #1dc9ff` | `--info-bg` | `--info-line` | `--info-text` |

> Use sempre os tokens compostos (`--ok-bg`, `--ok-line`, `--ok-text`) — nunca o hex direto.

---

## 3. Temas: Escuro (padrão) ↔ Claro

### Tema Escuro (`:root`, `[data-theme="dark"]`)
- **Fundo**: `--bg: #050d17` (navy profundo)
- **Superfícies**: `--surface-1: #08192b` → `--surface-3: #103049`
- **Texto**: `--text-1: #eaf6ff` → `--text-3: #7191a7`
- **Bordas**: `--line: rgba(122,190,240,.14)`
- **Appbar**: `--appbar-bg: #01017a`
- **Sidebar**: `--sidebar-bg: #171c64`

### Tema Claro (`[data-theme="light"]`)
- **Fundo**: `--bg: #eef3f9`
- **Superfícies**: `--surface-1: #ffffff` → `--surface-3: #e9f0f8`
- **Texto**: `--text-1: #0a1c2e` → `--text-3: #6b849b`
- **Bordas**: `--line: rgba(14,48,82,.13)`
- **Appbar/Sidebar**: mantêm cores navy (#01017a / #171c64)

**Alternância**: toggle `[data-theme="light"]` no `<html>`. Nenhum componente muda — só os tokens.

---

## 4. Tipografia

| Token | Valor | Escala |
|-------|-------|--------|
| `--font-sans` | `Inter, "Segoe UI Variable", system-ui...` | Família principal |
| `--font-mono` | `ui-monospace, "JetBrains Mono", Consolas...` | Código, métricas |

**Tamanhos** (base 16px)
```
--fs-10: .625rem  (10px) — micro rótulos
--fs-12: .75rem   (12px) — small
--fs-13: .8125rem (13px) — legendas
--fs-14: .875rem  (14px) — **corpo padrão**
--fs-16: 1rem     (16px) — ênfase
--fs-20: 1.25rem  (20px) — h2
--fs-24: 1.5rem   (24px) — h3
--fs-32: 2rem     (32px) — h1
--fs-44: 2.75rem  (44px) — hero
```

**Line-height**
- `--lh-tight: 1.15` — títulos
- `--lh-base: 1.55` — corpo

**Kicker** (label uppercase)
```css
.kicker { font-size: var(--fs-10); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--cyan-400); }
```

---

## 5. Espaçamento — Grade de 4px

```css
--s-1: 4px   --s-2: 8px   --s-3: 12px  --s-4: 16px
--s-5: 20px  --s-6: 24px  --s-8: 32px  --s-10: 40px
--s-12: 48px --s-16: 64px
```
> Use **apenas** estes valores. Não invente `15px`, `18px`, etc.

---

## 6. Raios de Borda

| Token | Valor | Uso |
|-------|-------|-----|
| `--r-sm` | 8px | Inputs, badges, botões pequenos |
| `--r-md` | 12px | Cards, modais, dropdowns |
| `--r-lg` | 16px | Painéis grandes |
| `--r-xl` | 22px | Containers de destaque |
| `--r-full` | 999px | Pills, avatares, botões circulares |

---

## 7. Movimento

| Token | Valor | Uso |
|-------|-------|-----|
| `--dur-1` | 120ms | Micro-interações (hover, focus) |
| `--dur-2` | 200ms | Transições padrão (sidebar, modais) |
| `--dur-3` | 320ms | Animações complexas (page enter) |
| `--ease` | `cubic-bezier(.2,.7,.3,1)` | Padrão (entrada/saída suave) |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Saídas rápidas |

**Reduced motion**: `@media (prefers-reduced-motion: reduce)` desliga tudo (ver `base.css:152`).

---

## 8. Layout & Z-Index

```css
--appbar-h: 64px
--mobile-nav-h: 0px (desktop) / 56px (mobile)
--sidebar-w: 288px
--sidebar-w-collapsed: 72px
--page-max: 1560px

--z-drawer: 60
--z-modal: 70
--z-toast: 90
--z-palette: 100
```

---

## 9. Sombras

| Token | Escuro | Claro | Uso |
|-------|--------|-------|-----|
| `--shadow-1` | `0 1px 2px rgba(0,0,0,.35)` | `0 1px 2px rgba(12,40,70,.07)` | Cards, inputs |
| `--shadow-2` | `0 12px 32px rgba(0,0,0,.38)` | `0 10px 26px rgba(12,40,70,.10)` | Dropdowns, sidebars |
| `--shadow-3` | `0 28px 70px rgba(0,0,0,.52)` | `0 24px 60px rgba(12,40,70,.16)` | Modais |
| `--shadow-brand` | `0 12px 30px rgba(11,116,255,.28)` | `0 10px 26px rgba(11,116,255,.22)` | Botão primário hover |

---

## 10. Foco & Acessibilidade

```css
:focus-visible {
  outline: 2px solid var(--cyan-400);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}
:root[data-theme="light"] :focus-visible { outline-color: var(--brand-500); }
```
- **Nunca remova** `:focus-visible`
- Skip link obrigatório no topo de cada página (`.skip-link`)
- Contraste mínimo WCAG AA em ambos os temas

---

## 11. Componentes de Referência

### Botão Primário
```css
.btn-primary {
  background: var(--grad-brand);
  color: var(--text-on-brand);
  border: 0;
  border-radius: var(--r-md);
  padding: var(--s-2) var(--s-5);
  font-weight: 600;
  box-shadow: var(--shadow-1);
  transition: transform var(--dur-1), box-shadow var(--dur-1);
}
.btn-primary:hover { box-shadow: var(--shadow-brand); transform: translateY(-1px); }
.btn-primary:active { transform: translateY(0); }
```

### Card Padrão
```css
.card {
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  padding: var(--s-5);
}
```

### Input
```css
.input {
  background: var(--surface-input);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: var(--s-2) var(--s-3);
  color: var(--text-1);
  transition: border-color var(--dur-1), box-shadow var(--dur-1);
}
.input:focus { border-color: var(--cyan-400); box-shadow: var(--focus-ring); }
```

### Badge de Estado
```css
.badge { display: inline-flex; align-items: center; gap: var(--s-1); font-size: var(--fs-10); font-weight: 700; letter-spacing: .05em; padding: 2px var(--s-2); border-radius: var(--r-full); }
.badge--ok    { background: var(--ok-bg);    color: var(--ok-text);    border: 1px solid var(--ok-line); }
.badge--warn  { background: var(--warn-bg);  color: var(--warn-text);  border: 1px solid var(--warn-line); }
.badge--danger{ background: var(--danger-bg); color: var(--danger-text); border: 1px solid var(--danger-line); }
.badge--info  { background: var(--info-bg);  color: var(--info-text);  border: 1px solid var(--info-line); }
```

---

## 12. Regras para Agentes de IA

1. **Tokens only** — Nunca escreva `#0b74ff` ou `16px` direto no HTML/CSS/JSX. Use `var(--brand-500)`, `var(--s-4)`, etc.
2. **Tema-agnóstico** — Componentes devem funcionar em ambos os temas sem overrides de cor.
3. **Grade 4px** — Espaçamentos, paddings, gaps, margins: múltiplos de 4px via tokens `--s-*`.
4. **Semântica primeiro** — Use `--ok-*`, `--warn-*`, `--danger-*`, `--info-*` para estados. Não crie cores customizadas.
5. **Tipografia** — Heading = `font-weight: 700`, `letter-spacing: -.02em`. Corpo = `var(--fs-14)`, `var(--lh-base)`.
6. **Movimento** — Transições só via `--dur-1/2/3` + `--ease`. Respeite `prefers-reduced-motion`.
7. **Foco visível** — Todo elemento interativo precisa de `:focus-visible` consistente.
8. **Z-index** — Use apenas a escala `--z-*` definida. Não invente `z-index: 9999`.
9. **Scrollbar** — Herda do `base.css` (thin, `var(--line-strong)`). Não sobrescreva.
10. **Print** — `@media print` já oculta chrome da app (appbar, sidebar, toasts). Não duplique.

---

## 13. Checklist de Entrega (PR)

- [ ] Nenhum valor hardcoded de cor, espaçamento, raio, duração
- [ ] Funciona em `data-theme="dark"` e `"light"`
- [ ] `:focus-visible` visível e consistente
- [ ] `prefers-reduced-motion` respeitado
- [ ] Contraste AA verificado (ferramenta: DevTools → Rendering → Emulate CSS media → prefers-color-scheme)
- [ ] Tokens importados de `tokens.css` (não duplicados)

---

## 14. Arquivos de Referência

| Arquivo | Descrição |
|---------|-----------|
| `public/css/noc/tokens.css` | **Fonte da verdade** — todos os design tokens |
| `public/css/noc/base.css` | Reset, tipografia, acessibilidade, scrollbar, print |
| `public/css/noc/components.css` | Componentes compostos (botões, cards, inputs, badges, etc.) |
| `public/css/noc/screens.css` | Layout de telas (shell, appbar, sidebar, grid) |
| `public/prototype/design-system.html` | Playground visual dos componentes |

---

> **Dúvida?** Consulte `tokens.css` primeiro. Se o token não existe, **não invente** — abra issue para adicionar ao design system.