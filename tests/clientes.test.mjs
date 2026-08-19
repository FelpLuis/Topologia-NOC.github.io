import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../collector/server.mjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/clientes.html", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../public/js/noc-clientes.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../public/js/noc-ui.js", import.meta.url), "utf8");
const gponMap = fs.readFileSync(new URL("../public/js/noc-gpon-map.js", import.meta.url), "utf8");

test("coletor expõe endpoint forçado de sincronização OLT + IXC", () => {
  assert.match(server, /\/api\/gpon\/sync/);
  assert.match(server, /await syncFull\(true\)/);
  assert.match(server, /forced: true/);
  // A força também empurra o snapshot atualizado ao Worker.
  assert.match(server, /await syncFull\(/);
});

test("worker expõe refresh que força a OLT/IXC e o CRUD de clientes", () => {
  assert.match(worker, /\/api\/gpon\/refresh/);
  assert.match(worker, /handleGponRefresh/);
  assert.match(worker, /\/api\/clientes/);
  assert.match(worker, /handleClientesList|handleClientesCreate|handleClientesGet|handleClientesUpdate|handleClientesDelete/);
  assert.match(worker, /\/api\/clientes\/feed/);
  assert.match(worker, /aplicarCadastroClientes/);
  // Senhas do cadastro usam a mesma cifra AES-GCM das credenciais.
  assert.match(worker, /encryptClienteSenha/);
  assert.match(worker, /decryptClienteSenha/);
  assert.match(worker, /clienteAdditionalData/);
  // A senha nunca via para a lista: só o booleano de existência.
  assert.match(worker, /has_senha_pppoe/);
  assert.match(worker, /has_senha_roteador/);
  assert.match(worker, /has_senha_wifi/);
});

test("tela de Cadastro de Cliente existe, com ícone e rota", () => {
  assert.match(worker, /\["clientes", "Cadastro de Cliente"/);
  assert.match(worker, /\/clientes\.html/);
});

test("ações do módulo Cadastro de cliente", () => {
  assert.match(worker, /clientes\.view/, "clientes.view");
  assert.match(worker, /clientes\.create/, "clientes.create");
  assert.match(worker, /clientes\.edit/, "clientes.edit");
  assert.match(worker, /clientes\.delete/, "clientes.delete");
});

test("Cadastro de Cliente é concedido a todos os perfis do catálogo", () => {
  for (const role of ["gerente", "analista", "atendimento", "tecnico", "logistica"]) {
    assert.match(worker, new RegExp(`"${role}": \\[`, "s"));
  }
  // view/create/edit para todos os perfis operacionais; delete só admin.
  const gerente = worker.slice(worker.indexOf('"gerente":'), worker.indexOf('"analista":'));
  assert.match(gerente, /clientes\.delete/);
  const atendimento = worker.slice(worker.indexOf('"atendimento":'), worker.indexOf('"tecnico":'));
  assert.doesNotMatch(atendimento, /clientes\.delete/);
  // A tela clientes está em todos os ROLE_SCREENS.
  const analista = worker.slice(worker.indexOf('"analista":'), worker.indexOf('"atendimento":'));
  assert.match(analista, /"clientes"/);
});

test("Cadastro de Cliente aparece em todos os setores do menu", () => {
  // A tela é global no catálogo e o frontend replica para cada setor.
  assert.match(worker, /SCREENS_GLOBAIS/);
  assert.match(worker, /CASE WHEN s\.code IN .* THEN 1 ELSE 0 END global/);
  assert.match(ui, /n\.global/);
  assert.match(ui, /if \(n\.global\) setores\.forEach/);
  // Fallback de navegação também o marca como global.
  assert.match(ui, /global: true/);
});

test("o feed GPON recebe o cadastro do cliente sobreposto", () => {
  // handleGponClients e refresh aplicam o cadastro sobre o feed da OLT/IXC.
  assert.match(worker, /await aplicarCadastroClientes\(env, await carregarFeedGpon\(env\)\)/);
  assert.match(worker, /await aplicarCadastroClientes\(env, feed\)/);
});

test("botão Atualizar força sincronização e o painel mostraEditar cadastro", () => {
  assert.match(gponMap, /NOC\.api\("\/api\/gpon\/refresh", .*method: "POST"*/);
  assert.match(gponMap, /data-editar-cadastro/);
  assert.match(gponMap, /window\.NOC_CLIENTES/);
  // As páginas do mapa carregam o runtime de cadastro.
  assert.match(fs.readFileSync(new URL("../public/gpon.html", import.meta.url), "utf8"), /noc-clientes\.js/);
  assert.match(fs.readFileSync(new URL("../public/gpon-mapa.html", import.meta.url), "utf8"), /noc-clientes\.js/);
});

test("Cadastro de Cliente tem os campos solicitados", () => {
  assert.match(runtime, /fLoginPppoe/);
  assert.match(runtime, /fSenhaPppoe/);
  assert.match(runtime, /fLoginRoteador/);
  assert.match(runtime, /fSenhaRoteador/);
  assert.match(runtime, /fSsid/);
  assert.match(runtime, /fSenhaWifi/);
  assert.match(runtime, /ont_serial/i);
  assert.match(runtime, /ip_gerencia/i);
  assert.match(runtime, /valor_mensal/i);
  assert.match(runtime, /vencimento_dia/i);
  assert.match(runtime, /aparelhos_json/i);
  assert.match(runtime, /fAparelhos/);
  assert.match(html, /id="clienteListBody"/);
});
