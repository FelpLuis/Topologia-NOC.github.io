/* ============================================================
   UPDOWN NOC — projeção geográfica e camada de tiles (OpenStreetMap)
   Sem biblioteca de terceiros: o CSP do Worker só libera script
   próprio, e o fundo precisa viver dentro do mesmo transform de
   zoom/pan que o mapa da topologia já usa. Aqui ficam apenas a
   matemática do Web Mercator e o gerenciador de tiles.
   ============================================================ */
window.GEO = (() => {
  "use strict";

  const TILE = 256;                 // lado do tile, em pixels
  const MAX_LAT = 85.05112878;      // limite do Web Mercator
  const MIN_Z = 2, MAX_Z = 19;      // níveis servidos pelo OpenStreetMap
  const TILE_URL = "https://tile.openstreetmap.org";
  const ATTRIBUTION = "© OpenStreetMap contributors";

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* Projeção Web Mercator no nível 0: o planeta inteiro em 256 px. Qualquer
     outro nível é este resultado multiplicado por 2^z — é por isso que o mapa
     da topologia guarda um fator `k` (= 2^zoom, podendo ser fracionário) em vez
     de um nível inteiro: assim o zoom do mapa não fica preso aos degraus do
     tile. */
  function project(lat, lon) {
    const la = clamp(Number(lat), -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return {
      x: (Number(lon) + 180) / 360 * TILE,
      y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * TILE,
    };
  }

  function unproject(x, y) {
    const n = Math.PI - 2 * Math.PI * (y / TILE);
    return {
      lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      lon: ((x / TILE * 360 - 180) + 540) % 360 - 180,
    };
  }

  /* Number(null) e Number("") valem 0: sem descartar vazio antes, um campo em
     branco viraria a coordenada 0°,0°. */
  const informado = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const isCoord = (lat, lon) =>
    informado(lat) && informado(lon) &&
    Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180;

  /* Aceita o que o operador consegue copiar de um mapa: "-23.99, -46.30",
     "-23,99 -46,30" e o par que o Google Maps coloca na área de transferência. */
  function parseCoords(texto) {
    const m = String(texto || "").match(/(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1].replace(",", "."));
    const lon = Number(m[2].replace(",", "."));
    return isCoord(lat, lon) ? { lat, lon } : null;
  }

  const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "");
  const label = (lat, lon) => `${fmt(lat)}, ${fmt(lon)}`;

  /* Nível de tile que deixa cada tile perto de 256 px na tela. */
  const tileZoom = (k, escala = 1) => clamp(Math.round(Math.log2(k * escala)), MIN_Z, MAX_Z);

  /* ------------------------------------------------------------
     Camada de tiles

     Os tiles são posicionados em coordenadas do "mundo" da topologia
     (px do mercator no nível 0 × k, menos a origem), portanto herdam
     o mesmo translate/scale das caixas dos POPs e nunca saem do lugar
     durante o arrasto.
     ------------------------------------------------------------ */
  function basemap(host) {
    const tiles = new Map();          // "z/coluna/linha" → <img>
    let zAtual = null, pendentes = 0, limpeza = null;

    /* Os tiles do nível anterior continuam na tela enquanto os novos carregam:
       sem isso, cada passo de zoom pisca um retângulo vazio. */
    function descartarAntigos() {
      clearTimeout(limpeza);
      limpeza = null;
      tiles.forEach((img, key) => {
        if (Number(img.dataset.z) === zAtual) return;
        img.remove();
        tiles.delete(key);
      });
    }

    function novoTile(z, coluna, linha, n) {
      const img = document.createElement("img");
      const x = ((coluna % n) + n) % n;   // o mundo se repete na horizontal
      img.src = `${TILE_URL}/${z}/${x}/${linha}.png`;
      img.alt = "";
      img.loading = "eager";
      img.decoding = "async";
      img.dataset.z = String(z);
      img.style.zIndex = String(z);
      pendentes++;
      const pronto = () => {
        img.classList.add("is-ready");
        if (--pendentes <= 0) descartarAntigos();
      };
      img.addEventListener("load", pronto, { once: true });
      img.addEventListener("error", pronto, { once: true });
      return img;
    }

    /* view: { k, ox, oy, escala, x0, y0, x1, y1 } — a janela visível já em
       coordenadas do mundo. Devolve o nível de tile desenhado. */
    function render(view) {
      if (!Number.isFinite(view.k) || view.k <= 0 || !Number.isFinite(view.escala) || view.escala <= 0) return null;
      const z = tileZoom(view.k, view.escala);
      const n = 2 ** z;
      const lado = TILE * view.k / n;           // lado do tile em px do mundo
      const col = (x) => Math.floor((x + view.ox) / lado);
      const lin = (y) => Math.floor((y + view.oy) / lado);

      const c0 = col(view.x0), c1 = col(view.x1);
      const l0 = Math.max(0, lin(view.y0)), l1 = Math.min(n - 1, lin(view.y1));

      if (z !== zAtual) { zAtual = z; pendentes = 0; }
      const usados = new Set();
      // Teto de segurança: um viewport enorme com zoom mínimo não deve disparar
      // milhares de requisições ao servidor de tiles.
      let orcamento = 400;

      for (let l = l0; l <= l1 && orcamento > 0; l++) {
        for (let c = c0; c <= c1 && orcamento > 0; c++, orcamento--) {
          const key = `${z}/${c}/${l}`;
          usados.add(key);
          let img = tiles.get(key);
          if (!img) {
            img = novoTile(z, c, l, n);
            tiles.set(key, img);
            host.appendChild(img);
          }
          img.style.left = `${c * lado - view.ox}px`;
          img.style.top = `${l * lado - view.oy}px`;
          img.style.width = `${lado}px`;
          img.style.height = `${lado}px`;
        }
      }

      // Fora da janela: o nível atual some na hora; os demais esperam a
      // limpeza, para não abrir buracos enquanto o novo nível carrega.
      tiles.forEach((img, key) => {
        if (usados.has(key)) return;
        if (Number(img.dataset.z) !== z) return;
        img.remove();
        tiles.delete(key);
      });

      if (pendentes <= 0) descartarAntigos();
      else if (!limpeza) limpeza = setTimeout(descartarAntigos, 900);
      return z;
    }

    function clear() {
      clearTimeout(limpeza);
      limpeza = null;
      pendentes = 0;
      zAtual = null;
      tiles.forEach((img) => img.remove());
      tiles.clear();
    }

    return { render, clear };
  }

  return {
    TILE, MIN_Z, MAX_Z, ATTRIBUTION,
    project, unproject, isCoord, parseCoords, fmt, label, tileZoom, basemap, clamp,
  };
})();
