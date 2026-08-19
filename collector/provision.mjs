/* ============================================================
   UPDOWN NOC — provisionamento de usuários nos aparelhos via SSH
   O Worker (Cloudflare) não abre sessão SSH: ele deixa os jobs em
   device_target_provisioning e este módulo — que roda no coletor Node,
   dentro da rede/VPn das OLTs — busca os pendentes, conecta no aparelho
   com a credencial de administração cadastrada no destino e cria ou
   atualiza a conta do usuário, fabricante a fabricante.
   ============================================================ */
import { Client as SshClient } from "ssh2";
import net from "node:net";

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
export const cleanCli = (text) => String(text || "").replace(ANSI, "").replace(/\r/g, "");

/* Prompt genérico de terminal de rede: termina em `#` (Cisco/Datacom/ZTE/Nokia),
   `>` (MikroTik) ou em `[modo]` (Huawei em system-view). */
const PROMPT = /(?:^|\r?\n)\s*(?:\[[^\]]+\](?:\s*[#>])?|[\w@./:()\[\]-]*\s*[#>])\s*$/;
const ERROR_HINT = /already\s+exist|already\s+in\s+use|failure|invalid|error|unknown\s+command|denied|falha|erro|inv[aá]lido/i;

/* Uma etapa pode ser:
   - string: envia o comando e espera o prompt;
   - { cmd, optional:true }: envia e ignora erro/desconhecido;
   - { run }: função que recebe o shell e decide por conta própria. */
function step(cmd, options = {}) {
  return { cmd, ...options };
}

export const ADAPTERS = {
  cisco: {
    label: "Cisco (IOS/IOS-XE)",
    steps(u, p) {
      return [
        step("terminal length 0", { optional: true }),
        step("configure terminal"),
        step(`username ${u} privilege 15 secret ${p}`),
        step("end"),
        step("write memory"),
      ];
    },
  },

  /* Datacom (DMOS) usa CLI de família Cisco. */
  datacom: {
    label: "Datacom (DMOS)",
    steps(u, p) {
      return [
        step("configure terminal"),
        step(`username ${u} privilege 15 password 0 ${p}`),
        step("end"),
        step("write memory"),
      ];
    },
  },

  /* Huawei VRP/MA5600T: local-user é idempotente — criar de novo atualiza. */
  huawei: {
    label: "Huawei (VRP)",
    steps(u, p) {
      return [
        step("system-view"),
        step("aaa"),
        step(`local-user ${u} password cipher ${p}`),
        step(`local-user ${u} service-type telnet ssh`),
        step(`local-user ${u} privilege level 15`),
        step("return"),
        step("save", { optional: true }),
        step("y", { optional: true }),
      ];
    },
  },

  /* ZTE ZXAN/ROS: user add falha se já existe — troca para user modify. */
  zte: {
    label: "ZTE (OLT ZXAN/ROS)",
    steps(u, p) {
      return [
        step("config"),
        step(`user add username ${u} password ${p}`, {
          tolerant: true,
          fallback: `user modify username ${u} password ${p}`,
          when: (output) => ERROR_HINT.test(output),
        }),
        step("exit"),
        step("quit", { optional: true }),
      ];
    },
  },

  /* MikroTik RouterOS: add falha se existe; set atualiza. */
  mikrotik: {
    label: "MikroTik (RouterOS)",
    steps(u, p) {
      return [
        step(`/user add name=${u} password=${p} group=full`, {
          tolerant: true,
          fallback: `/user set [find name=${u}] password=${p} group=full`,
          when: (output) => ERROR_HINT.test(output),
        }),
      ];
    },
  },

  /* Nokia SR OS (TiMOS): re-executar atualiza a senha do usuário. */
  nokia: {
    label: "Nokia (SR OS/TiMOS)",
    steps(u, p) {
      return [
        step(`configure system user ${u} password ${p} access console ssh telnet home-root cf3:`),
        step("exit-all"),
      ];
    },
  },

  /* Linux (servidor): cria a conta se faltar e sempre redefine a senha. */
  linux: {
    label: "Linux (servidor)",
    steps(u, p) {
      const pwd = String(p).replace(/'/g, `'\\''`);
      return [
        step(`useradd -m ${u} 2>/dev/null; printf '%s\\n' '${u}:${pwd}' | chpasswd`),
      ];
    },
  },

  outro: {
    label: "Outro / manual",
    steps() {
      throw new Error("Fabricante sem adaptador de provisionamento: crie a conta manualmente ou mapeie o CLI em collector/provision.mjs.");
    },
  },
};

/* ---------------- sessão CLI genérica (SSH ou TELNET) ---------------- */
function sshCli(device, prompt) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const fail = (error) => { try { conn.end(); } catch {} reject(error); };
    conn.once("error", fail).once("ready", () => {
      conn.shell({ term: "vt100", rows: 0, cols: 200 }, (error, stream) => {
        if (error) return fail(error);
        let buffer = "", waiter = null;
        const settle = () => {
          if (!waiter || !prompt.test(cleanCli(buffer))) return;
          const current = waiter; waiter = null;
          clearTimeout(current.timer); current.resolve(cleanCli(buffer)); buffer = "";
        };
        stream.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (buffer.length > 64 * 1024 * 1024) return fail(new Error(`Saída do aparelho excedeu 64 MiB (${device.host})`));
          settle();
        });
        stream.once("error", fail).once("close", () => waiter && fail(new Error("Sessão SSH encerrada pelo aparelho")));
        const waitPrompt = (timeoutMs = 60000) => new Promise((res, rej) => {
          waiter = { resolve: res, reject: rej, timer: setTimeout(() => { waiter = null; rej(new Error("Tempo esgotado aguardando prompt do aparelho")); }, timeoutMs) };
          settle();
        });
        const run = async (cmd, timeoutMs) => { buffer = ""; stream.write(`${cmd}\r`); return waitPrompt(timeoutMs); };
        waitPrompt(15000).then(() => resolve({ run, close: () => { try { stream.end("exit\r"); } catch {} conn.end(); } }), fail);
      });
    }).connect({
      host: device.host, port: device.port, username: device.username, password: device.password,
      readyTimeout: 15000,
      algorithms: {
        serverHostKey: { append: ["ssh-rsa", "ssh-dss"] },
        cipher: { append: ["aes128-cbc", "3des-cbc"] },
        hmac: { append: ["hmac-sha1", "hmac-md5"] },
      },
    });
  });
}

function stripTelnet(data, socket) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 255) { out.push(data[i]); continue; }
    const verb = data[++i], option = data[++i];
    if (verb === 253) socket.write(Buffer.from([255, 252, option])); // DO -> WONT
    else if (verb === 251) socket.write(Buffer.from([255, 254, option])); // WILL -> DONT
  }
  return Buffer.from(out).toString("latin1");
}

function telnetCli(device, prompt) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: device.host, port: device.port });
    socket.setNoDelay(true); socket.setTimeout(180000);
    let buffer = "", stage = "username", waiter = null, settled = false;
    const fail = (error) => {
      try { socket.destroy(); } catch {}
      if (waiter) { const current = waiter; waiter = null; clearTimeout(current.timer); current.reject(error); }
      else if (!settled) reject(error);
    };
    const promptReady = () => prompt.test(cleanCli(buffer));
    const settleCommand = () => {
      if (!waiter || !promptReady()) return;
      const current = waiter; waiter = null; clearTimeout(current.timer);
      const value = cleanCli(buffer); buffer = ""; current.resolve(value);
    };
    socket.on("data", (chunk) => {
      buffer += stripTelnet(chunk, socket);
      if (buffer.length > 64 * 1024 * 1024) return fail(new Error(`Saída do aparelho excedeu 64 MiB (${device.host})`));
      if (stage === "username" && /(?:Username|login)\s*:\s*$/i.test(buffer)) { socket.write(`${device.username}\r\n`); buffer = ""; stage = "password"; return; }
      if (stage === "password" && /Password\s*:\s*$/i.test(buffer)) { socket.write(`${device.password}\r\n`); buffer = ""; stage = "prompt"; return; }
      if (stage === "prompt" && promptReady()) {
        settled = true; stage = "ready"; buffer = "";
        const run = (cmd, timeoutMs = 60000) => new Promise((res, rej) => {
          buffer = "";
          waiter = { resolve: res, reject: rej, timer: setTimeout(() => { waiter = null; rej(new Error("Tempo esgotado aguardando resposta Telnet")); }, timeoutMs) };
          socket.write(`${cmd}\r\n`);
        });
        resolve({ run, close: () => { try { socket.end("exit\r\n"); } catch {} } });
        return;
      }
      if (/incorrect|failed|invalid/i.test(buffer) && stage !== "ready") return fail(new Error("Autenticação Telnet recusada"));
      settleCommand();
    });
    socket.once("error", fail).once("timeout", () => fail(new Error("Tempo esgotado na sessão Telnet")));
  });
}

export function openCli(device) {
  return device.protocol === "ssh" ? sshCli(device, PROMPT) : telnetCli(device, PROMPT);
}

/* ---------------- execução do job ---------------- */
async function runStep(shell, entry) {
  if (typeof entry === "function") return entry(shell);
  const spec = typeof entry === "object" ? entry : { cmd: entry };
  const output = await shell.run(spec.cmd);
  const flagged = spec.when && spec.when(output);
  if (flagged && spec.fallback) {
    await shell.run(spec.fallback);
    return;
  }
  if (flagged && spec.tolerant) return; // falha tolerada sem fallback
  if (!spec.optional && ERROR_HINT.test(output)) {
    const first = output.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "resposta inesperada";
    throw new Error(`${spec.cmd} → ${first}`);
  }
}

export async function provisionJob(job) {
  const adapter = ADAPTERS[job.vendor] || ADAPTERS.outro;
  const shell = await openCli({
    host: job.ip, port: job.port, protocol: job.protocol,
    username: job.provision_username, password: job.provision_password,
  });
  try {
    const steps = adapter.steps(job.login_username, job.password);
    for (const entry of steps) await runStep(shell, entry);
    return { ok: true };
  } finally {
    try { shell.close(); } catch {}
  }
}

/* ---------------- integração com o Worker ---------------- */
export async function provisionPendingJobs(config, onLog = () => {}) {
  const base = String(config.provisioningUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("PROVISIONING_URL não configurado no coletor");
  const headers = {
    Authorization: `Bearer ${config.pushToken}`,
    "Content-Type": "application/json",
  };
  const fetchJobs = await fetch(`${base}/api/provisioning/pending`, { headers, signal: AbortSignal.timeout(30000) });
  if (!fetchJobs.ok) throw new Error(`Worker provisionamento: HTTP ${fetchJobs.status}`);
  const { jobs } = await fetchJobs.json();
  if (!Array.isArray(jobs) || !jobs.length) return { jobs: 0, ok: 0, errors: 0 };

  let ok = 0, errors = 0;
  for (const job of jobs) {
    const report = { ok: true };
    try {
      const result = await provisionJob(job);
      report.ok = result.ok;
    } catch (error) {
      report.ok = false;
      report.error = error?.message || String(error);
      errors += 1;
    }
    if (report.ok) ok += 1;
    try {
      const response = await fetch(
        `${base}/api/provisioning/${encodeURIComponent(job.target_id)}/${job.user_id}/report`,
        { method: "POST", headers, body: JSON.stringify({ ...report, username: job.login_username }), signal: AbortSignal.timeout(30000) }
      );
      if (!response.ok) throw new Error(`Worker report: HTTP ${response.status}`);
      onLog(`${report.ok ? "OK" : "ERRO"} ${job.vendor} ${job.target_name} → ${job.login_username}${report.error ? ` (${report.error})` : ""}`);
    } catch (error) {
      errors += 1;
      onLog(`Falha ao reportar ${job.target_name}: ${error?.message || String(error)}`);
    }
  }
  return { jobs: jobs.length, ok, errors };
}