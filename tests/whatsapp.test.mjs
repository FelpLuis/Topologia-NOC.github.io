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
  assert.match(client, /togglePresence/);
  assert.match(client, /renderPresence/);
});