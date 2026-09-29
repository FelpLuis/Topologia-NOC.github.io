/* ============================================================
   UPDOWN NOC — gravador de áudio do chat
   A Meta só entrega como áudio ogg/opus, mp3, m4a, aac ou amr. O Firefox
   grava ogg/opus direto e o Safari grava m4a; o Chrome só grava WebM, que lá
   vira "documento". Como o som dentro do WebM já é Opus, basta trocar o
   contêiner: webmParaOgg() tira os pacotes do WebM e os reembala em páginas
   Ogg, sem recodificar nada.
   ============================================================ */
window.NOCGravador = (() => {
  "use strict";

  const CANDIDATOS = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"];

  function suportado() {
    return !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
  }

  /* ---------- leitura do WebM (EBML) ---------- */

  // Elementos em que é preciso entrar; o resto é pulado pelo tamanho.
  const DESCER = new Set([0x18538067, 0x1654AE6B, 0xAE, 0x1F43B675, 0xA0]);
  const SIMPLE_BLOCK = 0xA3, BLOCK = 0xA1, CODEC_ID = 0x86, CODEC_PRIVATE = 0x63A2;

  function lerId(b, p) {
    const primeiro = b[p];
    let len = 1;
    while (len <= 4 && !(primeiro & (0x80 >> (len - 1)))) len++;
    if (len > 4) throw new Error("WebM inválido");
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
    return [id, len];
  }

  function lerTamanho(b, p) {
    const primeiro = b[p];
    let len = 1;
    while (len <= 8 && !(primeiro & (0x80 >> (len - 1)))) len++;
    if (len > 8) throw new Error("WebM inválido");
    let valor = primeiro & (0xFF >> len), tudoUm = valor === (0xFF >> len);
    for (let i = 1; i < len; i++) {
      valor = valor * 256 + b[p + i];
      if (b[p + i] !== 0xFF) tudoUm = false;
    }
    return [tudoUm ? -1 : valor, len];
  }

  function extrairOpus(b) {
    let codec = "", head = null, p = 0;
    const pacotes = [];
    while (p < b.length) {
      const [id, lenId] = lerId(b, p);
      const [tamanho, lenTam] = lerTamanho(b, p + lenId);
      const ini = p + lenId + lenTam;
      if (DESCER.has(id)) { p = ini; continue; }
      // O MediaRecorder só marca tamanho desconhecido em Segment e Cluster.
      if (tamanho < 0) throw new Error("WebM com tamanho desconhecido");
      const fim = ini + tamanho;
      if (fim > b.length) break; // último pedaço cortado no meio: ignora
      if (id === CODEC_ID) codec = String.fromCharCode(...b.subarray(ini, fim));
      else if (id === CODEC_PRIVATE) head = b.slice(ini, fim);
      else if (id === SIMPLE_BLOCK || id === BLOCK) {
        const [, lenTrilha] = lerTamanho(b, ini);
        const flags = b[ini + lenTrilha + 2];
        if (flags & 0x06) throw new Error("WebM com lacing");
        pacotes.push(b.slice(ini + lenTrilha + 3, fim));
      }
      p = fim;
    }
    if (codec && codec !== "A_OPUS") throw new Error(`Codec ${codec} não é Opus`);
    if (!pacotes.length) throw new Error("Gravação vazia");
    return { head, pacotes };
  }

  /* ---------- escrita do Ogg ---------- */

  const CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04C11DB7 : r << 1;
    CRC[i] = r >>> 0;
  }

  const texto = s => Uint8Array.from(s, c => c.charCodeAt(0));

  function cabecalhoOpus(canais = 1) {
    const h = new Uint8Array(19);
    h.set(texto("OpusHead"));
    const v = new DataView(h.buffer);
    h[8] = 1; h[9] = canais;
    v.setUint16(10, 312, true);
    v.setUint32(12, 48000, true);
    return h;
  }

  function tagsOpus() {
    const fornecedor = texto("UPDOWN NOC");
    const t = new Uint8Array(8 + 4 + fornecedor.length + 4);
    t.set(texto("OpusTags"));
    new DataView(t.buffer).setUint32(8, fornecedor.length, true);
    t.set(fornecedor, 12);
    return t;
  }

  // Amostras (a 48 kHz) de um pacote Opus, pelo byte TOC (RFC 6716, 3.1).
  function amostras(pacote) {
    if (!pacote.length) return 0;
    const toc = pacote[0], config = toc >> 3;
    const porQuadro = config < 12 ? [480, 960, 1920, 2880][config & 3]
      : config < 16 ? [480, 960][config & 1]
      : [120, 240, 480, 960][config & 3];
    const c = toc & 3;
    return porQuadro * (c === 0 ? 1 : c === 3 ? (pacote[1] & 0x3F) : 2);
  }

  function pagina(pacotes, granulo, serie, seq, tipo) {
    const segs = [];
    for (const p of pacotes) {
      for (let n = p.length; ; n -= 255) {
        segs.push(Math.min(n, 255));
        if (n < 255) break;
      }
    }
    const corpo = pacotes.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(27 + segs.length + corpo);
    const v = new DataView(out.buffer);
    out.set(texto("OggS"));
    out[5] = tipo;
    v.setUint32(6, granulo % 0x100000000, true);
    v.setUint32(10, Math.floor(granulo / 0x100000000), true);
    v.setUint32(14, serie, true);
    v.setUint32(18, seq, true);
    out[26] = segs.length;
    out.set(segs, 27);
    let pos = 27 + segs.length;
    for (const p of pacotes) { out.set(p, pos); pos += p.length; }
    let crc = 0;
    for (let i = 0; i < out.length; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ out[i]) & 0xFF]) >>> 0;
    v.setUint32(22, crc, true);
    return out;
  }

  function webmParaOgg(bytes) {
    const { head, pacotes } = extrairOpus(bytes);
    const opusHead = head && String.fromCharCode(...head.subarray(0, 8)) === "OpusHead" ? head : cabecalhoOpus();
    const serie = (Math.random() * 0xFFFFFFFF) >>> 0;
    const paginas = [pagina([opusHead], 0, serie, 0, 2), pagina([tagsOpus()], 0, serie, 1, 0)];
    let granulo = 0, seq = 2, lote = [], segs = 0;
    const fechar = ultimo => {
      paginas.push(pagina(lote, granulo, serie, seq++, ultimo ? 4 : 0));
      lote = []; segs = 0;
    };
    pacotes.forEach((p, i) => {
      const precisa = Math.floor(p.length / 255) + 1;
      if (segs + precisa > 255 || lote.length >= 50) fechar(false);
      lote.push(p); segs += precisa;
      granulo += amostras(p);
      if (i === pacotes.length - 1) fechar(true);
    });
    const total = paginas.reduce((s, p) => s + p.length, 0);
    const ogg = new Uint8Array(total);
    let pos = 0;
    for (const p of paginas) { ogg.set(p, pos); pos += p.length; }
    return ogg;
  }

  /* ---------- gravação ---------- */

  async function iniciar() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = CANDIDATOS.find(t => MediaRecorder.isTypeSupported(t)) || "";
    const partes = [];
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      rec.ondataavailable = e => { if (e.data.size) partes.push(e.data); };
      rec.start(1000);
    } catch (err) {
      stream.getTracks().forEach(t => t.stop()); // não deixa o microfone aberto
      throw err;
    }
    const encerrar = () => new Promise(resolve => {
      if (rec.state === "inactive") return resolve();
      rec.onstop = () => resolve();
      rec.stop();
    }).finally(() => stream.getTracks().forEach(t => t.stop()));

    return {
      inicio: Date.now(),
      async parar() {
        await encerrar();
        const tipo = (rec.mimeType || mime || "audio/webm").split(";")[0];
        const blob = new Blob(partes, { type: tipo });
        if (tipo === "audio/webm") {
          try {
            return { blob: new Blob([webmParaOgg(new Uint8Array(await blob.arrayBuffer()))], { type: "audio/ogg" }), tipo: "audio/ogg" };
          } catch (err) {
            console.warn("[gravador] conversão para ogg falhou, enviando webm:", err);
          }
        }
        return { blob, tipo };
      },
      cancelar() { encerrar(); }
    };
  }

  return { suportado, iniciar, webmParaOgg };
})();
