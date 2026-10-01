import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const page = await readFile(new URL("../public/whatsapp.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/js/noc-whatsapp.js", import.meta.url), "utf8");

test("WhatsApp persiste conversas, mensagens e presença", () => {
  assert.match(worker, /CREATE TABLE IF NOT EXISTS wa_conversations/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS wa_messages/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS wa_agent_presence/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS wa_contacts/);
  assert.match(worker, /idx_wa_msg_wamid/);
});

test("webhook da Meta faz verificação e recebe eventos", () => {
  assert.match(worker, /handleWhatsappWebhookVerify/);
  assert.match(worker, /hub\.verify_token/);
  assert.match(worker, /hub\.challenge/);
  assert.match(worker, /X-Hub-Signature-256/);
  assert.match(worker, /\/api\/whatsapp\/webhook/);
});

test("rotas da API exigem permissões granulares", () => {
  for (const permission of ["whatsapp.view", "whatsapp.chat", "whatsapp.supervise", "whatsapp.manage"])
    assert.match(worker, new RegExp(`requirePermission\\s*\\(\\s*env\\s*,\\s*request\\s*,\\s*"${permission.replace(".", "\\.")}"`));
  assert.match(worker, /\/api\/whatsapp\/conversations/);
});

test("tela e ações estão no catálogo do Worker", () => {
  assert.match(worker, /"whatsapp", "Chat WhatsApp"/);
  assert.match(worker, /whatsapp\.supervise/);
  assert.match(worker, /whatsapp\.manage/);
  assert.match(worker, /seed\.whatsapp\.v1/);
});

test("bot roteia conversa para o setor escolhido", () => {
  assert.match(worker, /waMatchSector/);
  assert.match(worker, /routing_attempts/);
  assert.match(worker, /settings\.routingDone/);
  assert.match(worker, /\{setor\}/);
});

test("tela oferece lista de conversas, presença e chat", () => {
  assert.match(page, /id="convList"/);
  assert.match(page, /id="presenceList"/);
  assert.match(page, /id="messages"/);
  assert.match(page, /id="composer"/);
  assert.match(page, /data-action="whatsapp\.supervise"/);
});

test("front atualiza por polling e controla presença", () => {
  assert.match(client, /setInterval/);
  assert.match(client, /\/api\/whatsapp\/conversations\//);
  assert.match(client, /takeConversation/);
  assert.match(client, /setPresence/);
  assert.match(client, /renderPresence/);
});

test("rotina do atendente: online, pausas com teto e offline", () => {
  assert.match(worker, /pausa: \{ label: "Pausa \(café, água, banheiro\)", limitMin: 15 \}/);
  assert.match(worker, /almoco: \{ label: "Almoço", limitMin: 60 \}/);
  // coluna nova no CREATE TABLE do SCHEMA: é o que dispara a migração
  assert.match(worker, /status TEXT NOT NULL DEFAULT 'online',\n  since TEXT,/);
  assert.match(worker, /ensureColumns\(db, "wa_agent_presence"/);
  assert.match(worker, /"WHATSAPP_PRESENCE"/);
  assert.match(worker, /waSetPresence\(env, request, db, gate\.user, "online"\)/);
  assert.match(page, /id="presenceMenu"/);
  for (const code of ["online", "pausa", "almoco", "offline"]) assert.match(client, new RegExp(`\\b${code}: \\{ label:`));
  assert.match(client, /pauseClock/);
});

test("canais externos (Opa!Suite Meta e Webchat) caem na mesma fila", () => {
  assert.match(worker, /channel TEXT NOT NULL DEFAULT 'whatsapp'/);
  assert.match(worker, /external_id TEXT NOT NULL DEFAULT ''/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS wa_webhook_log/);
  assert.match(worker, /\/api\/opasuite\/webhook/);
  assert.match(worker, /async function handleOpasuiteWebhook/);
  assert.match(worker, /async function oaExtractMessage|function oaExtractMessage/);
  assert.match(worker, /async function omniSendText/);
  assert.match(worker, /WHERE phone=\? AND channel=\?/);
  assert.match(worker, /requirePermission\s*\(\s*env\s*,\s*request\s*,\s*"whatsapp\.manage"\s*\)/);
  assert.match(worker, /\/api\/whatsapp\/webhook-log/);
});

test("badge de canal aparece na lista e no cabeçalho do chat", () => {
  assert.match(client, /CHANNEL_LABELS/);
  assert.match(client, /channelBadge/);
  assert.match(client, /opasuite_meta/);
  assert.match(client, /opasuite_webchat/);
});
test("lista traz os encerrados da última semana em consulta própria", () => {
  assert.match(worker, /WHERE c\.status='closed'\$\{scope\}/);
  assert.match(worker, /c\.updated_at>=datetime\('now','-7 days'\)/);
  assert.match(client, /bucketOf/);
  assert.match(page, /data-status="closed"/);
});

test("mensagens rápidas são normalizadas nas configurações e usadas no composer", () => {
  assert.match(worker, /quickReplies/);
  assert.match(worker, /shortcut: String\(q\?\.shortcut/);
  assert.match(client, /applyQuick/);
  assert.match(client, /\{atendente\}/);
});

test("atendente envia anexo e áudio pelo chat web", () => {
  assert.match(page, /id="attachBtn"/);
  assert.match(page, /id="fileInput" type="file" multiple/);
  assert.match(page, /id="recorder"/);
  assert.match(page, /\/js\/noc-gravador\.js/);
  assert.match(client, /\/api\/whatsapp\/uploads/);
  assert.match(client, /NOCGravador\.iniciar/);
  assert.match(client, /class="wa-audio"/);
  assert.match(client, /class="wa-doc"/);
  // o upload aceita áudio e documentos, não só imagem
  assert.match(worker, /"audio\/ogg": "ogg"/);
  assert.match(worker, /"application\/pdf": "pdf"/);
  // pelo número da Meta o arquivo sobe para a Graph API antes de ir na mensagem
  assert.match(worker, /async function waSendMedia/);
  assert.match(worker, /\/\$\{phoneId\}\/media`/);
  assert.match(worker, /async function waFetchInboundMedia/);
  // a coluna precisa estar no SCHEMA: é ele que muda SCHEMA_FINGERPRINT e faz a
  // migração rodar; só com ensureColumns o banco de produção não a ganhava (500)
  assert.match(worker, /CREATE TABLE IF NOT EXISTS wa_messages \([^;]*media_name TEXT[^;]*caption TEXT/);
  assert.match(worker, /\["media_name", "TEXT NOT NULL DEFAULT ''"\]/);
  // "microphone=()" bloqueava a gravação sem o navegador nem perguntar
  assert.doesNotMatch(worker, /"camera=\(\), microphone=\(\)/);
  assert.match(worker, /microphone=\(self\)/);
  assert.match(worker, /media-src 'self' blob:/);
  // player de áudio precisa de Range para mostrar a duração
  assert.match(worker, /status: 206/);
});

test("rota de mídia do App UpDown aceita só chave de anexo do atendente", () => {
  const fonte = worker.match(/const UA_CHAVE_DE_MIDIA = (\/.+\/);/);
  assert.ok(fonte, "UA_CHAVE_DE_MIDIA precisa ser uma regex literal");
  const chave = new Function(`return ${fonte[1]}`)();
  assert.ok(chave instanceof RegExp);
  assert.ok(chave.test("staff/7/5da98d8d-b45f-401e-a650-6936280a3dd9.ogg"));
  for (const ruim of ["staff/7/../../etc/passwd", "client/3/5da98d8d-b45f-401e-a650-6936280a3dd9.ogg", "staff/x/5da98d8d-b45f-401e-a650-6936280a3dd9.ogg", "staffX7/5da98d8d-b45f-401e-a650-6936280a3dd9.ogg"])
    assert.equal(chave.test(ruim), false, ruim);
  assert.match(worker, /if \(!UA_CHAVE_DE_MIDIA\.test\(chave\)\)/);
});

test("anexo do cliente no App UpDown vira mídia no chat", () => {
  assert.match(worker, /async function uaBaixarMidia/);
  assert.match(worker, /\/integracoes\/noc\/midia\/\$\{id\}/);
  // o marcador sai quando o arquivo chega, inclusive o antigo "veja no console"
  assert.match(worker, /DELETE FROM wa_messages WHERE wa_message_id=\? AND type='text' AND body LIKE '📎 %'/);
  assert.doesNotMatch(worker, /anexos\} anexos`\} — veja no console do app/);
});

test("diagnóstico do celular do App UpDown chega ao painel do chat", () => {
  // As funções puras saem do worker e rodam aqui: o diagnóstico vai parar no HTML
  // do atendente, então o filtro de tipo e tamanho precisa valer de verdade.
  const carimbo = worker.match(/function uaCarimbo\(iso\) \{[\s\S]*?\n\}/)[0];
  const ini = worker.indexOf("const UA_CONEXOES");
  const fim = worker.indexOf("async function uaGuardarDiagnostico");
  assert.ok(ini > 0 && fim > ini);
  const { uaDiagnostico, uaResumoDiagnostico } = new Function(`${carimbo}\n${worker.slice(ini, fim)}\nreturn { uaDiagnostico, uaResumoDiagnostico };`)();

  const d = uaDiagnostico({
    medidoEm: "2026-10-01T12:30:00.000Z", conexao: "wifi", redeWifi: " CASA_5G ", operadora: null,
    naRedeDaUpdown: true, localizacao: { latitude: -7.2307, longitude: -35.8817, precisaoMetros: 14 },
    velocidade: { downloadMbps: 312.4, uploadMbps: 151.9, pingMs: 7, jitterMs: 2, servidor: "app.updown.com.br" },
    avisos: [], extra: "<script>"
  });
  assert.equal(d.medidoEm, "2026-10-01 12:30:00");
  assert.equal(d.redeWifi, "CASA_5G");
  assert.equal(d.extra, undefined);
  assert.equal(uaResumoDiagnostico(d), "📶 Diagnóstico do celular: Wi-Fi CASA_5G · ↓ 312 ↑ 152 Mbps · ping 7 ms");

  const movel = uaDiagnostico({ medidoEm: "2026-10-01T12:30:00Z", conexao: "satelite", operadora: "TIM",
    localizacao: { latitude: 999, longitude: 0 }, velocidade: { downloadMbps: "rápido" }, avisos: ["localizacao_negada", 3] });
  assert.equal(movel.conexao, "desconhecida");
  assert.equal(movel.localizacao, null);
  assert.equal(movel.velocidade, null);
  assert.deepEqual(movel.avisos, ["localizacao_negada"]);
  assert.equal(uaDiagnostico({ conexao: "wifi" }), null, "sem medidoEm não é diagnóstico");

  // guardado na conversa (coluna também no SCHEMA, por causa da impressão digital)
  assert.match(worker, /client_id TEXT,\n  app_diagnostico TEXT,/);
  assert.match(worker, /\["app_diagnostico", "TEXT"\]/);
  assert.match(worker, /if \(p\.diagnostico\) await uaGuardarDiagnostico/);
  // vai no detalhe da conversa e fica fora da lista recarregada a cada 5 s
  assert.match(worker, /cliente: cliente \|\| null, diagnostico \}/);
  assert.match(worker, /rows\.map\(\(\{ app_diagnostico, \.\.\.c \}\)/);
  // painel mostra só nos chats do app e se atualiza no polling
  assert.match(client, /conv\.channel === "updown_app" \? deviceSection\(state\.diagnostico\)/);
  assert.match(client, /if \(clienteChanged \|\| diagChanged\) renderSide\(\)/);
});

test("gravador converte WebM/Opus do Chrome em Ogg/Opus válido", async () => {
  const { runInNewContext } = await import("node:vm");
  const code = await readFile(new URL("../public/js/noc-gravador.js", import.meta.url), "utf8");
  const ctx = { window: {}, navigator: {} };
  runInNewContext(code, ctx);
  const { webmParaOgg } = ctx.window.NOCGravador;

  // WebM mínimo do jeito que o MediaRecorder grava: Segment e Cluster com
  // tamanho desconhecido, CodecPrivate com OpusHead e SimpleBlocks sem lacing.
  const el = (id, body) => {
    const idBytes = []; for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v & 0xFF);
    return [...idBytes, 0x01, 0, 0, 0, ...[3, 2, 1, 0].map(i => (body.length >>> (i * 8)) & 0xFF), ...body];
  };
  const unknown = id => { const b = []; for (let v = id; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xFF); return [...b, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; };
  const head = [..."OpusHead"].map(c => c.charCodeAt(0)).concat([1, 1, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0]);
  const pacote = n => [0xF8 | 0, ...Array.from({ length: n }, (_, i) => (i * 7) & 0xFF)]; // config 31: CELT 20 ms, 1 quadro
  const bloco = (t, n) => el(0xA3, [0x81, 0, t, 0x80, ...pacote(n)]);
  const webm = Uint8Array.from([
    ...el(0x1A45DFA3, el(0x4282, [..."webm"].map(c => c.charCodeAt(0)))),
    ...unknown(0x18538067),
    ...el(0x1654AE6B, el(0xAE, [...el(0x86, [..."A_OPUS"].map(c => c.charCodeAt(0))), ...el(0x63A2, head)])),
    ...unknown(0x1F43B675), ...el(0xE7, [0]),
    ...bloco(0, 40), ...bloco(20, 300), ...bloco(40, 10)
  ]);

  const ogg = webmParaOgg(webm);
  const crcTab = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04C11DB7 : r << 1; crcTab[i] = r >>> 0; }
  const paginas = [];
  for (let p = 0; p < ogg.length;) {
    assert.equal(String.fromCharCode(...ogg.subarray(p, p + 4)), "OggS");
    const nseg = ogg[p + 26];
    const len = 27 + nseg + ogg.subarray(p + 27, p + 27 + nseg).reduce((s, v) => s + v, 0);
    const pg = ogg.slice(p, p + len);
    const v = new DataView(pg.buffer);
    const crc = v.getUint32(22, true);
    pg.fill(0, 22, 26);
    let c = 0; for (const b of pg) c = ((c << 8) ^ crcTab[((c >>> 24) ^ b) & 0xFF]) >>> 0;
    assert.equal(c, crc, "CRC da página Ogg");
    paginas.push({ tipo: pg[5], granulo: v.getUint32(6, true), dados: pg.subarray(27 + nseg) });
    p += len;
  }
  assert.equal(paginas.length, 3);
  assert.equal(paginas[0].tipo, 2, "primeira página marca início do fluxo");
  assert.deepEqual([...paginas[0].dados], head, "OpusHead do WebM é reaproveitado");
  assert.equal(String.fromCharCode(...paginas[1].dados.subarray(0, 8)), "OpusTags");
  assert.equal(paginas[2].tipo, 4, "última página marca fim do fluxo");
  assert.equal(paginas[2].granulo, 3 * 960, "3 pacotes de 20 ms a 48 kHz");
  assert.equal(paginas[2].dados.length, 41 + 301 + 11);
});
