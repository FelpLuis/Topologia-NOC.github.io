import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pops = await readFile(new URL("../public/js/noc-pops.js", import.meta.url), "utf8");
const topology = await readFile(new URL("../public/js/noc-topology.js", import.meta.url), "utf8");

/* A lista de equipamentos vinculados teve, por um tempo, um botão "Detalhes"
   que abria um modal próprio — uma segunda ficha, ao lado do drawer que a
   Topologia já usava. As duas telas removeram esse botão (8cf561f e 2de6afc) e
   consolidaram tudo no drawer: quem quer a ficha completa clica em "Abrir".
   Os testes abaixo descrevem esse caminho, que é o que existe. */

test("a lista de equipamentos do POP leva à ficha na Topologia", () => {
  // "Abrir" carrega o id na query, e é a topologia que abre a ficha a partir
  // dela — sem isso o botão levaria ao mapa sem selecionar nada.
  assert.match(pops, /href="\/topologia\.html\?device=\$\{encodeURIComponent\(e\.id\)\}"/);
  assert.match(topology, /href="\/topologia\.html\?device=\$\{encodeURIComponent\(e\.id\)\}"/);
});

test("a Topologia abre a ficha do equipamento pedido na query", () => {
  // É a outra ponta do "Abrir": sem este trecho o link chegaria à tela e o
  // operador teria de procurar o equipamento na mão.
  assert.match(topology, /function openDevice\(id\)/);
  assert.match(topology, /centerOn\(wanted\); openDevice\(wanted\);/);
});

test("a ficha do equipamento vive só no drawer da Topologia", () => {
  // Duas fichas para o mesmo equipamento foi o que gerou o botão órfão: o
  // modal ficou no arquivo 125 linhas depois de ninguém mais poder abri-lo.
  for (const [nome, fonte] of [["noc-pops.js", pops], ["noc-topology.js", topology]]) {
    assert.doesNotMatch(fonte, /openDeviceDetails/, `${nome} não deve ressuscitar a segunda ficha`);
    assert.doesNotMatch(fonte, /data-device-details/, `${nome} não deve ter bind sem botão que o dispare`);
  }
});

test("desvincular equipamento continua exigindo permissão de edição", () => {
  // A única ação destrutiva que restou na linha do equipamento.
  assert.match(pops, /data-unlink="\$\{esc\(e\.id\)\}" \$\{canEdit \? "" : "disabled"\}/);
  assert.match(pops, /\$\$\("\[data-unlink\]"\)\.forEach/);
});
