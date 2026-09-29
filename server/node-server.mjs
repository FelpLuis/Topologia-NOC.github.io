/* Adaptador que roda o Worker em Node, sem Cloudflare.
   O src/worker.js continua sendo a única fonte da aplicação: aqui só
   reconstruímos as quatro coisas que o runtime da Cloudflare dava de graça —
   o binding ASSETS, a Cache API, o ctx.waitUntil e o gatilho do cron. */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, normalize, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/worker.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const CRON_MS = Number(process.env.CRON_INTERVAL_MS || 5 * 60 * 1000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf"
};

/* Um caminho vindo da URL nunca pode escapar de public/: normalizamos e
   conferimos o prefixo em vez de confiar no join. */
function resolveInsidePublic(pathname) {
  const alvo = normalize(join(PUBLIC_DIR, pathname));
  if (alvo !== PUBLIC_DIR && !alvo.startsWith(PUBLIC_DIR + sep)) return null;
  return alvo;
}

/* Reproduz o roteamento do Cloudflare Assets: "/" vira index.html e caminho
   sem extensão também responde pelo .html correspondente — é disso que o
   routeCandidates() do worker depende. */
function assetCandidates(pathname) {
  const limpo = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  if (extname(limpo)) return [limpo];
  return [limpo, `${limpo}.html`, `${limpo}/index.html`];
}

const ASSETS = {
  async fetch(request) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    for (const candidato of assetCandidates(pathname)) {
      const arquivo = resolveInsidePublic(candidato);
      if (!arquivo) break;
      try {
        const info = await stat(arquivo);
        if (!info.isFile()) continue;
        const corpo = await readFile(arquivo);
        return new Response(request.method === "HEAD" ? null : corpo, {
          status: 200,
          headers: {
            "Content-Type": MIME[extname(arquivo).toLowerCase()] || "application/octet-stream",
            "Content-Length": String(info.size),
            "Last-Modified": info.mtime.toUTCString()
          }
        });
      } catch {
        /* candidato inexistente: tenta o próximo */
      }
    }
    return new Response("Not Found", { status: 404 });
  }
};

/* Cache API em memória. É um processo só, então um Map basta; o worker já
   trata cache como otimização opcional e sobrevive a qualquer falha aqui. */
class MemoryCache {
  #entries = new Map();

  #key(request) {
    return typeof request === "string" ? request : request.url;
  }

  async match(request) {
    const chave = this.#key(request);
    const entrada = this.#entries.get(chave);
    if (!entrada) return undefined;
    if (entrada.expiresAt <= Date.now()) {
      this.#entries.delete(chave);
      return undefined;
    }
    return new Response(entrada.body, { status: entrada.status, headers: new Headers(entrada.headers) });
  }

  async put(request, response) {
    const maxAge = /max-age=(\d+)/i.exec(response.headers.get("cache-control") || "");
    const ttl = maxAge ? Number(maxAge[1]) : 0;
    if (ttl <= 0) return;
    const body = Buffer.from(await response.arrayBuffer());
    this.#entries.set(this.#key(request), {
      body,
      status: response.status,
      headers: [...response.headers],
      expiresAt: Date.now() + ttl * 1000
    });
  }

  async delete(request) {
    return this.#entries.delete(this.#key(request));
  }
}

if (typeof globalThis.caches === "undefined") {
  const nomeadas = new Map();
  const padrao = new MemoryCache();
  globalThis.caches = {
    default: padrao,
    async open(nome) {
      if (!nomeadas.has(nome)) nomeadas.set(nome, new MemoryCache());
      return nomeadas.get(nome);
    }
  };
}

/* Substitui o bucket R2 "MEDIA" (anexos e áudios do chat): cada objeto vira um
   arquivo em MEDIA_DIR e o Content-Type vai num .meta.json ao lado. Só
   implementa o pedaço da API do R2 que o worker usa — put, get, arrayBuffer e
   writeHttpMetadata. A chave nunca pode escapar da pasta, mesmo vinda de URL. */
class DiskBucket {
  constructor(dir) {
    this.dir = normalize(dir);
  }

  #arquivo(key) {
    const alvo = normalize(join(this.dir, String(key)));
    if (!alvo.startsWith(this.dir + sep)) return null;
    return alvo;
  }

  async put(key, bytes, options = {}) {
    const arquivo = this.#arquivo(key);
    if (!arquivo) throw new Error("Chave de mídia inválida.");
    await mkdir(dirname(arquivo), { recursive: true });
    await writeFile(arquivo, Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes));
    const contentType = options.httpMetadata?.contentType || "application/octet-stream";
    await writeFile(`${arquivo}.meta.json`, JSON.stringify({ contentType }));
  }

  async get(key) {
    const arquivo = this.#arquivo(key);
    if (!arquivo || arquivo.endsWith(".meta.json")) return null;
    let corpo;
    try { corpo = await readFile(arquivo); } catch { return null; }
    let contentType = "application/octet-stream";
    try { contentType = JSON.parse(await readFile(`${arquivo}.meta.json`, "utf8")).contentType || contentType; } catch { /* sem metadado: binário genérico */ }
    const bytes = new Uint8Array(corpo.buffer, corpo.byteOffset, corpo.byteLength);
    return {
      size: bytes.byteLength,
      body: bytes,
      async arrayBuffer() { return bytes.slice().buffer; },
      writeHttpMetadata(headers) { headers.set("content-type", contentType); }
    };
  }
}

const MEDIA_DIR = process.env.MEDIA_DIR || join(ROOT, "data", "media");
const env = { ...process.env, ASSETS, MEDIA: new DiskBucket(MEDIA_DIR) };

/* waitUntil no Node é só não perder a promessa de vista: o processo é longo,
   ninguém vai congelar o isolate embaixo dela. O catch existe para uma falha
   em tarefa de fundo não derrubar o servidor inteiro. */
function criarContexto() {
  return {
    waitUntil(promise) {
      Promise.resolve(promise).catch(error => {
        console.error(JSON.stringify({
          message: "Tarefa em background falhou",
          error: error instanceof Error ? error.message : String(error)
        }));
      });
    },
    passThroughOnException() {}
  };
}

function nodeParaRequest(req) {
  /* Atrás do Caddy o protocolo real vem no cabeçalho: sem isso o worker monta
     redirect de login e cookie Secure em http e o navegador recusa. */
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const headers = new Headers();
  for (const [nome, valor] of Object.entries(req.headers)) {
    if (valor === undefined || nome.startsWith(":")) continue;
    for (const item of Array.isArray(valor) ? valor : [valor]) headers.append(nome, item);
  }
  const temCorpo = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: temCorpo ? Readable.toWeb(req) : undefined,
    duplex: temCorpo ? "half" : undefined
  });
}

async function responderNode(res, response) {
  const headers = {};
  for (const [nome, valor] of response.headers) {
    if (nome.toLowerCase() === "set-cookie") continue;
    headers[nome] = valor;
  }
  /* Vários Set-Cookie só sobrevivem via getSetCookie(): a iteração acima os
     junta numa string só, o que quebra a sessão no navegador. */
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie() : [];
  if (cookies.length) headers["set-cookie"] = cookies;

  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const response = await worker.fetch(nodeParaRequest(req), env, criarContexto());
    await responderNode(res, response);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Falha ao responder requisição",
      url: req.url,
      error: error instanceof Error ? error.stack : String(error)
    }));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Erro interno.");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ message: "NOC no ar", port: PORT }));
});

/* Substitui o "triggers.crons" do wrangler.jsonc. O worker já é tolerante a
   execução concorrente, mas serializamos assim mesmo: uma sincronização do
   Zabbix mais lenta que o intervalo não deve empilhar. */
let cronRodando = false;
setInterval(async () => {
  if (cronRodando) return;
  cronRodando = true;
  try {
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, criarContexto());
  } catch (error) {
    console.error(JSON.stringify({
      message: "Cron falhou",
      error: error instanceof Error ? error.message : String(error)
    }));
  } finally {
    cronRodando = false;
  }
}, CRON_MS);
