/* O acesso é a porta de entrada: se ele erra, ninguém entra em tela nenhuma.
   Dois jeitos de errar já aconteceram e ficam cobertos aqui:
   - trocar a ordem dos "?" posicionais, comparando o perfil com o código de uma
     tela global — a consulta volta vazia e todo usuário cai em "sem telas";
   - deixar o administrador depender do que está gravado no banco, e uma
     marcação perdida trancar do lado de fora justamente quem reabre o sistema. */
import assert from "node:assert/strict";
import test from "node:test";
import { consultaTelasDoAcesso } from "../src/worker.js";

/* Deslocamento de cada "?" no texto do SQL: é a posição, e não a contagem, que
   decide para qual parâmetro cada bind vai. */
const posicoesDosParametros = (sql) => {
  const posicoes = [];
  for (let i = sql.indexOf("?"); i !== -1; i = sql.indexOf("?", i + 1)) posicoes.push(i);
  return posicoes;
};

test("perfil comum: cada bind cai no ? que lhe pertence", () => {
  const { sql, binds } = consultaTelasDoAcesso({ roleId: 7, globais: ["clientes", "agenda"] });

  assert.equal(sql.split("?").length - 1, binds.length, "sobrou ou faltou bind para os ? do SQL");
  assert.deepEqual(binds, ["clientes", "agenda", 7]);

  // O perfil é o último ? e vive no JOIN, depois do CASE das telas globais.
  const [, , perfil] = posicoesDosParametros(sql);
  assert.ok(sql.slice(0, perfil).includes("JOIN role_screens"), "o perfil precisa ser o ? do JOIN");
  assert.ok(sql.includes("CASE WHEN s.code IN (?,?)"), "os globais são os ? do SELECT");
});

test("mestre: enxerga o catálogo ativo inteiro, sem passar por role_screens", () => {
  const { sql, binds } = consultaTelasDoAcesso({ mestre: true, roleId: 7, globais: ["clientes"] });

  assert.ok(!sql.includes("role_screens"), "o mestre não é filtrado pelas telas do perfil");
  assert.deepEqual(binds, ["clientes"], "sem o filtro de perfil, sobra apenas o bind dos globais");
  assert.equal(sql.split("?").length - 1, binds.length);
  assert.ok(sql.includes("WHERE s.active=1"), "telas desativadas seguem fora, até para o mestre");
});

test("tela em vários setores: os setores saem de screen_sectors, com NOC como padrão", () => {
  const { sql } = consultaTelasDoAcesso({ roleId: 7, globais: ["clientes"] });

  assert.ok(sql.includes("FROM screen_sectors"), "o vínculo tela ↔ setor mora em screen_sectors");
  assert.ok(/group_concat\(sec\.code\)[\s\S]*'noc'\) sectors/.test(sql), "sem vínculo, a tela cai no bloco NOC");
  assert.ok(!/\bs\.sector_id/.test(sql),"a coluna antiga de setor único não é mais lida");
});
