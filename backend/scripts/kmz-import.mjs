/* ============================================================
   UPDOWN NOC — importação do KMZ do backbone para a PARTE ISP
   Lê o KMZ exportado do Google Earth Pro e gera as sementes da
   topologia ISP em public/data/isp-*.json:

     - LineString  → caminho de fibra  (isp-fibras.json)
     - ponto de infraestrutura (CEO, RT., SUB., cx, poste)
                   → caixa óptica     (isp-caixas.json)
     - ponto nomeado (cliente ou POP)
                   → POP              (isp-pops.json)

   Uso:  node backend/scripts/kmz-import.mjs "caminho/arquivo.kmz"

   O resultado é só a semente: a partir da primeira abertura da tela
   quem manda é o D1, e tudo é editável pela interface.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const DESTINO = path.join(RAIZ, "public", "data");

/* ---------------- leitura do KMZ ---------------- */
/* O KMZ é um ZIP com um doc.kml dentro. Descompactar à mão evita puxar uma
   dependência só para ler um arquivo que o repositório já versiona em JSON. */
function lerKmz(arquivo) {
  const buf = fs.readFileSync(arquivo);
  if (buf.slice(0, 2).toString("latin1") !== "PK") return buf.toString("utf8"); // .kml puro
  // Assinatura do "end of central directory" para varrer as entradas do ZIP.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("KMZ inválido: fim do diretório central não encontrado.");
  let ponteiro = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < total; i++) {
    const nomeLen = buf.readUInt16LE(ponteiro + 28);
    const extraLen = buf.readUInt16LE(ponteiro + 30);
    const comentLen = buf.readUInt16LE(ponteiro + 32);
    const nome = buf.slice(ponteiro + 46, ponteiro + 46 + nomeLen).toString("utf8");
    const inicioLocal = buf.readUInt32LE(ponteiro + 42);
    if (/\.kml$/i.test(nome)) {
      const metodo = buf.readUInt16LE(inicioLocal + 8);
      const tamanho = buf.readUInt32LE(inicioLocal + 18) || buf.readUInt32LE(ponteiro + 20);
      const dados = inicioLocal + 30 + buf.readUInt16LE(inicioLocal + 26) + buf.readUInt16LE(inicioLocal + 28);
      const bruto = buf.slice(dados, dados + tamanho);
      return (metodo === 0 ? bruto : zlib.inflateRawSync(bruto)).toString("utf8");
    }
    ponteiro += 46 + nomeLen + extraLen + comentLen;
  }
  throw new Error("KMZ inválido: nenhum .kml dentro do arquivo.");
}

/* ---------------- utilidades de XML ---------------- */
const destag = (s) => String(s ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, "&").trim();
const tag = (xml, nome) => {
  const m = xml.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`));
  return m ? destag(m[1]) : "";
};

/* ---------------- cores das linhas ---------------- */
/* No KML a cor vem como aabbggrr; a tela precisa de #rrggbb. StyleMap aponta
   para o estilo "normal", que é o desenhado no mapa. */
const COR_PADRAO = "#38bdf8";
function tabelaDeCores(kml) {
  const estilos = new Map();
  for (const m of kml.matchAll(/<Style id="([^"]+)">([\s\S]*?)<\/Style>/g)) {
    const cor = (m[2].match(/<LineStyle>[\s\S]*?<color>([0-9a-fA-F]{8})<\/color>/) || [])[1];
    if (cor) estilos.set(m[1], `#${cor.slice(6, 8)}${cor.slice(4, 6)}${cor.slice(2, 4)}`.toLowerCase());
  }
  const mapas = new Map();
  for (const m of kml.matchAll(/<StyleMap id="([^"]+)">([\s\S]*?)<\/StyleMap>/g)) {
    const normal = (m[2].match(/<key>normal<\/key>\s*<styleUrl>#([^<]+)<\/styleUrl>/) || [])[1];
    if (normal) mapas.set(m[1], normal);
  }
  return (styleUrl) => {
    let id = String(styleUrl || "").replace(/^#/, "");
    for (let i = 0; i < 4 && mapas.has(id); i++) id = mapas.get(id);
    return estilos.get(id) || COR_PADRAO;
  };
}

/* ---------------- classificação dos pontos ---------------- */
/* Ponto de infraestrutura do caminho de fibra: caixa de emenda (CEO),
   reserva técnica (RT.), trecho subterrâneo (SUB.), travessia (TRA), poste.
   Tudo o que não cai aqui é um site com nome próprio — cliente ISP ou POP. */
const CAIXAS = [
  [/^ceo(?![a-z])/i, "CEO"],
  [/^rt[.,]?\b/i, "Reserva técnica"],
  [/^sub[.,]?\b/i, "Subterrâneo"],
  [/^tra\b/i, "Travessia"],
  [/^cx\b/i, "Caixa"],
  [/^poste\b/i, "Poste"],
  [/^ponto\s*\d+$/i, "Ponto de referência"],
  [/^\d+$/, "Ponto de referência"],
  [/^medida do caminho$/i, "Ponto de referência"],
];
const tipoDeCaixa = (nome) => (CAIXAS.find(([re]) => re.test(nome)) || [])[1] || null;
/* Só o nome que COMEÇA com POP é ponto próprio: "NINO POP PG" é o site de um
   cliente instalado dentro do POP, e não um POP da UPDOWN. */
const ehPop = (nome) => /^pop\b/i.test(nome);

/* ---------------- classificação das linhas ---------------- */
/* "Medida do caminho" é o nome que o Google Earth dá a um traçado medido: é
   rota levantada em campo, não cabo cadastrado, e fica marcada como tal. */
function tipoDeFibra(nome) {
  if (!nome || /^medida do caminho$/i.test(nome)) return "Traçado";
  if (/cordoalha/i.test(nome)) return "Cordoalha";
  if (/^as\s*\d+/i.test(nome)) return "Cabo autossustentado";
  if (/subterr|sub\./i.test(nome)) return "Subterrâneo";
  if (/a[eé]rea/i.test(nome)) return "Aéreo";
  if (/rota|link/i.test(nome)) return "Rota";
  return "Cabo";
}
// "12 FO", "36 Fo", "12FO", "CABO 6Fo" — quantidade de fibras declarada no nome.
function fibrasNoNome(nome) {
  const m = String(nome).match(/(\d{1,3})\s*fo\b/i);
  return m ? Number(m[1]) : null;
}

/* Descrição que só repete a coordenada (decimal ou em graus/minutos) ou o
   próprio nome não acrescenta nada: a localização já é campo do cadastro. */
const SO_COORDENADA = /^-?\d{1,3}[.,]\d+\s*[,;\s]\s*-?\d{1,3}[.,]\d+$/;
const SO_DMS = /^\d{1,3}°\d{1,2}'[\d.]+"[NS]\s*\d{1,3}°\d{1,2}'[\d.]+"[EW]$/i;
function semRedundancia(descricao, nome) {
  const t = descricao.trim();
  if (!t || SO_COORDENADA.test(t) || SO_DMS.test(t)) return "";
  return t.toLowerCase() === String(nome || "").trim().toLowerCase() ? "" : t;
}

/* ---------------- geometria ---------------- */
const RAIO_TERRA = 6371000;
const rad = (g) => (g * Math.PI) / 180;
function extensao(pontos) {
  let total = 0;
  for (let i = 1; i < pontos.length; i++) {
    const [la1, lo1] = pontos[i - 1], [la2, lo2] = pontos[i];
    const dLat = rad(la2 - la1), dLon = rad(lo2 - lo1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLon / 2) ** 2;
    total += 2 * RAIO_TERRA * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return Math.round(total);
}
const arredonda = (v) => Number(Number(v).toFixed(6));

/* Coordenadas do KML vêm como "lon,lat,alt lon,lat,alt …" e são guardadas
   como [lat, lon] — a mesma ordem que o resto do sistema usa. */
function coordenadas(bloco) {
  return destag(bloco).split(/\s+/).filter(Boolean).map((par) => {
    const [lon, lat] = par.split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [arredonda(lat), arredonda(lon)] : null;
  }).filter(Boolean);
}

/* ---------------- identificadores ---------------- */
const slug = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sem-nome";
function unico(usados, base) {
  let id = base, n = 2;
  while (usados.has(id)) id = `${base}-${n++}`;
  usados.add(id);
  return id;
}

/* ---------------- importação ---------------- */
export function importar(kml, origem = "KMZ") {
  const corDe = tabelaDeCores(kml);
  // Só o que vem depois do primeiro <Folder> é conteúdo; antes disso são estilos.
  const corpo = kml.slice(Math.max(0, kml.indexOf("<Folder>")));

  const pops = [], caixas = [], fibras = [];
  const idsPop = new Set(), idsCaixa = new Set(), idsFibra = new Set();
  let semNome = 0;

  for (const m of corpo.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const pm = m[1];
    const nome = tag(pm, "name").replace(/\s+/g, " ");
    // A descrição do Google Earth vem em várias linhas; no cabeçalho do POP e
    // no painel da fibra ela ocupa uma linha só.
    const descricao = semRedundancia(
      tag(pm, "description").replace(/\s*\n\s*/g, " — ").replace(/\s+/g, " "), nome);
    const styleUrl = (pm.match(/<styleUrl>([^<]*)<\/styleUrl>/) || [])[1] || "";

    const linha = pm.match(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
    if (linha) {
      const pontos = coordenadas(linha[1]);
      if (pontos.length < 2) continue;
      const rotulo = nome || `Trecho sem nome ${++semNome}`;
      fibras.push({
        id: unico(idsFibra, `fib-${slug(rotulo)}`),
        nome: rotulo,
        tipo: tipoDeFibra(nome),
        fibras: fibrasNoNome(nome),
        cor: corDe(styleUrl),
        observacao: descricao || "",
        origem,
        extensao: extensao(pontos),
        pontos,
      });
      continue;
    }

    const ponto = pm.match(/<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
    if (!ponto) continue;
    const [coord] = coordenadas(ponto[1]);
    if (!coord) continue;
    const [lat, lon] = coord;

    const tipoCaixa = nome ? tipoDeCaixa(nome) : "Ponto de referência";
    if (tipoCaixa) {
      caixas.push({
        id: unico(idsCaixa, `cx-${slug(nome || "ponto")}`),
        nome: nome || "Ponto sem nome",
        tipo: tipoCaixa,
        observacao: descricao || "",
        origem,
        lat, lon,
      });
      continue;
    }

    // Site com nome próprio: POP da UPDOWN quando o nome diz POP, cliente ISP
    // em qualquer outro caso.
    const proprio = ehPop(nome);
    /* O campo endereço aparece no cabeçalho do POP, em uma linha. A descrição
       longa do Google Earth (documentação de DIO, por exemplo) não cabe lá e
       vai para a observação. */
    const curta = descricao.length <= 160;
    pops.push({
      id: unico(idsPop, `isp-${slug(nome)}`),
      nome,
      tipo: proprio ? "POP" : "Cliente ISP",
      endereco: curta ? descricao : "",
      observacao: curta ? "" : descricao,
      lat, lon,
      rotas: [],
      equipamentos: [],
      origem,
    });
  }

  return { pops, caixas, fibras };
}

/* ---------------- execução ---------------- */
const arquivo = process.argv[2];
if (arquivo) {
  const kml = lerKmz(arquivo);
  const { pops, caixas, fibras } = importar(kml, path.basename(arquivo, path.extname(arquivo)));

  const gravar = (nome, dados) => {
    fs.writeFileSync(path.join(DESTINO, nome), JSON.stringify(dados, null, 2) + "\n", "utf8");
    console.log(`  public/data/${nome} — ${dados.length} registro(s)`);
  };
  fs.mkdirSync(DESTINO, { recursive: true });
  console.log(`Importado de ${path.basename(arquivo)}:`);
  gravar("isp-pops.json", pops);
  gravar("isp-caixas.json", caixas);
  gravar("isp-fibras.json", fibras);
  if (!fs.existsSync(path.join(DESTINO, "isp-equipamentos.json"))) gravar("isp-equipamentos.json", []);
  if (!fs.existsSync(path.join(DESTINO, "isp-conexoes.json"))) gravar("isp-conexoes.json", []);

  const clientes = pops.filter((p) => p.tipo === "Cliente ISP");
  console.log(`\n  ${clientes.length} cliente(s) ISP: ${clientes.map((p) => p.nome).join(", ")}`);
  console.log(`  ${pops.length - clientes.length} POP(s) próprios: ${pops.filter((p) => p.tipo === "POP").map((p) => p.nome).join(", ")}`);
  console.log(`  ${(fibras.reduce((a, f) => a + f.extensao, 0) / 1000).toFixed(2)} km de caminho de fibra`);
}
