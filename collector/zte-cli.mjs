import { Client as SshClient } from "ssh2";
import net from "node:net";

const PROMPT = /(?:^|\r?\n)[\w.-]+#\s*$/;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
export const cleanCli = (text) => String(text || "").replace(ANSI, "").replace(/\r/g, "");

function sshShell(device) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const fail = (error) => { try { conn.end(); } catch {} reject(error); };
    conn.once("error", fail).once("ready", () => {
      conn.shell({ term: "vt100", rows: 0, cols: 200 }, (error, stream) => {
        if (error) return fail(error);
        let buffer = "", waiter = null;
        const settle = () => {
          if (!waiter || !PROMPT.test(cleanCli(buffer))) return;
          const current = waiter; waiter = null;
          clearTimeout(current.timer); current.resolve(cleanCli(buffer)); buffer = "";
        };
        stream.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (buffer.length > 64 * 1024 * 1024) return fail(new Error("Saída da OLT excedeu 64 MiB"));
          settle();
        });
        stream.once("error", fail).once("close", () => waiter && fail(new Error("Sessão SSH encerrada")));
        const waitPrompt = (timeoutMs = 120000) => new Promise((res, rej) => {
          waiter = { resolve: res, reject: rej, timer: setTimeout(() => { waiter = null; rej(new Error("Tempo esgotado aguardando prompt da OLT")); }, timeoutMs) };
          settle();
        });
        const command = async (cmd, timeoutMs) => { buffer = ""; stream.write(`${cmd}\r`); return waitPrompt(timeoutMs); };
        waitPrompt(15000).then(async () => {
          await command("terminal length 0", 10000);
          resolve({ command, close: () => { stream.end("exit\r"); conn.end(); } });
        }, fail);
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

function telnetShell(device) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: device.host, port: device.port });
    socket.setNoDelay(true); socket.setTimeout(180000);
    let buffer = "", stage = "username", waiter = null, settled = false;
    const fail = (error) => {
      try { socket.destroy(); } catch {}
      if (waiter) { const current = waiter; waiter = null; clearTimeout(current.timer); current.reject(error); }
      else if (!settled) reject(error);
    };
    const promptReady = () => PROMPT.test(cleanCli(buffer));
    const settleCommand = () => {
      if (!waiter || !promptReady()) return;
      const current = waiter; waiter = null; clearTimeout(current.timer);
      const value = cleanCli(buffer); buffer = ""; current.resolve(value);
    };
    socket.on("data", (chunk) => {
      buffer += stripTelnet(chunk, socket);
      if (buffer.length > 64 * 1024 * 1024) return fail(new Error("Saída da OLT excedeu 64 MiB"));
      if (stage === "username" && /(?:Username|login)\s*:\s*$/i.test(buffer)) { socket.write(`${device.username}\r\n`); buffer = ""; stage = "password"; return; }
      if (stage === "password" && /Password\s*:\s*$/i.test(buffer)) { socket.write(`${device.password}\r\n`); buffer = ""; stage = "prompt"; return; }
      if (stage === "prompt" && promptReady()) {
        settled = true; stage = "ready"; buffer = "";
        const command = (cmd, timeoutMs = 120000) => new Promise((res, rej) => {
          buffer = "";
          waiter = { resolve: res, reject: rej, timer: setTimeout(() => { waiter = null; rej(new Error("Tempo esgotado aguardando resposta Telnet")); }, timeoutMs) };
          socket.write(`${cmd}\r\n`);
        });
        command("terminal length 0", 10000).then(() => resolve({ command, close: () => { socket.end("exit\r\n"); } }), fail);
        return;
      }
      if (/incorrect|failed|invalid/i.test(buffer) && stage !== "ready") return fail(new Error("Autenticação Telnet recusada"));
      settleCommand();
    });
    socket.once("connect", () => {}).once("error", fail).once("timeout", () => fail(new Error("Tempo esgotado na sessão Telnet")));
  });
}

export const openZte = (device) => device.protocol === "ssh" ? sshShell(device) : telnetShell(device);

export function parseOnuStates(output, device) {
  const rows = [];
  for (const line of cleanCli(output).split("\n")) {
    const match = line.trim().match(/^(\d+\/\d+\/\d+:\d+)\s+(enable|disable)\s+(enable|disable)\s+(\S+)(?:\s+(.+))?$/i);
    if (!match) continue;
    const onuIndex = match[1], phase = match[4];
    rows.push({
      id: `${device.id}:${onuIndex}`, name: `ONU ${onuIndex}`,
      status: /^working$/i.test(phase) ? "online" : phase.toLowerCase(),
      serial: "", olt_id: device.id, pon: onuIndex.split(":")[0], onu_index: onuIndex,
      state_detail: phase,
    });
  }
  return rows;
}

export function parseOnuBaseInfo(output) {
  const byIndex = new Map();
  for (const line of cleanCli(output).split("\n")) {
    const match = line.trim().match(/^gpon-onu_(\d+\/\d+\/\d+:\d+)\s+(.+?)\s+(sn|loid|password|mac)\s+(?:SN:)?(\S+)\s+(\S+)$/i);
    if (!match) continue;
    byIndex.set(match[1], { model: match[2].trim(), auth_mode: match[3].toLowerCase(), serial: match[4], registration_state: match[5] });
  }
  return byIndex;
}

const inventoryCache = new Map();

/* Sessões persistentes por OLT.

   Abrir SSH/Telnet, autenticar e mandar "terminal length 0" custa alguns
   segundos — aceitável a cada dez minutos, proibitivo num ciclo de dez. Com a
   sessão viva, o ciclo rápido é só o tempo de a OLT despejar a tabela de
   estados. A fila serializa os comandos: dois "show" simultâneos no mesmo
   shell embaralham a saída dos dois. Qualquer falha derruba a sessão em vez de
   tentar reaproveitá-la — reconectar é barato perto de interpretar lixo. */
const sessions = new Map();

export async function withZteSession(device, fn) {
  let entry = sessions.get(device.id);
  if (!entry) { entry = { shell: null, queue: Promise.resolve() }; sessions.set(device.id, entry); }
  const execucao = entry.queue.then(async () => {
    if (!entry.shell) entry.shell = await openZte(device);
    try { return await fn(entry.shell); }
    catch (error) {
      try { entry.shell?.close(); } catch { /* a sessão já morreu */ }
      entry.shell = null;
      throw error;
    }
  });
  entry.queue = execucao.then(() => {}, () => {});
  return execucao;
}

export function closeZteSessions() {
  for (const entry of sessions.values()) {
    try { entry.shell?.close(); } catch { /* encerrando mesmo assim */ }
    entry.shell = null;
  }
}

/* Só a tabela de estados: é o dado que muda de segundo a segundo. Modelo,
   serial e modo de autenticação são cadastro e vêm do ciclo completo. */
export async function collectZteStates(device) {
  return withZteSession(device, async (shell) =>
    parseOnuStates(await shell.command("show gpon onu state", 240000), device));
}

export async function collectZte(device) {
  return withZteSession(device, async (shell) => {
    const states = parseOnuStates(await shell.command("show gpon onu state", 240000), device);
    let base = inventoryCache.get(device.id);
    if (!base) {
      base = new Map();
      const pons = [...new Set(states.map((onu) => onu.pon))];
      for (const pon of pons) {
        const rows = parseOnuBaseInfo(await shell.command(`show gpon onu baseinfo gpon-olt_${pon}`, 60000));
        rows.forEach((value, key) => base.set(key, value));
      }
      inventoryCache.set(device.id, base);
    }
    return states.map((onu) => ({ ...onu, ...(base.get(onu.onu_index) || {}) }));
  });
}
