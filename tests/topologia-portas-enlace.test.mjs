import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const topology = await readFile(new URL("../public/js/noc-topology.js", import.meta.url), "utf8");

/* Duas regras da tela de portas se contradiziam com o dado real da rede:
   1. "porta com nome está ocupada" — mas o nome da porta é a interface física,
      e a projeção do Zabbix escreve o if_name em toda porta que sincroniza.
      Resultado: nenhuma porta do outro lado aparecia e não dava para documentar
      enlace nenhum;
   2. "conectada é consequência do enlace, nunca uma escolha" — o operador
      marcava a porta como conectada, salvava, e ela voltava sozinha para livre.
   Os testes abaixo descrevem o comportamento que ficou. */

test("a porta oferecida do outro lado é a que não tem enlace, não a que não tem nome", () => {
  assert.match(topology, /function portaLivreParaEnlace\(e, p\) \{/);
  // A lista do seletor "Porta do outro lado" passa pela regra de enlace…
  assert.match(topology, /\.filter\(\(x\) => portaLivreParaEnlace\(d, x\) \|\| Number\(x\.numero\) === Number\(manter\)\)/);
  // …e a aba de conexões conta as mesmas portas para liberar "Documentar enlace".
  assert.match(topology, /const livres = \(e\.portas \|\| \[\]\)\.filter\(\(p\) => portaLivreParaEnlace\(e, p\)\);/);
});

test("nome de porta não conta mais como ocupação", () => {
  // O que ocupa é enlace documentado, ONU em porta PON ou o status marcado.
  assert.doesNotMatch(topology, /return !!\(p\.nome && p\.nome\.trim\(\)\);/);
  assert.match(topology, /function portaOcupadaView\(e, p\) \{[\s\S]*?return p\.status === "conectada";\n  \}/);
});

test("o status escolhido pelo operador é gravado como veio", () => {
  // Editor de uma porta: só o inverso é coagido — porta com enlace não fica livre.
  assert.match(
    topology,
    /p\.status = temEnlace && \(!escolhido \|\| escolhido === "livre"\) \? "conectada" : \(escolhido \|\| "livre"\);/
  );
  // Gerenciador de portas: mesma regra, e o seletor de status deixa de vir travado.
  assert.match(
    topology,
    /p\.status = ligada && \(!p\.status \|\| p\.status === "livre"\) \? "conectada" : \(p\.status \|\| "livre"\);/
  );
  assert.doesNotMatch(topology, /data-c="status" aria-label="Status da porta" \$\{c \? "disabled" : ""\}/);
});

test("o enlace cujo outro lado está em outro recorte continua aparecendo na porta", () => {
  // Resolver só no recorte aberto fazia o enlace gravado sumir da tela, e a
  // porta voltava a se dizer livre — parecia que a gravação não tinha ido.
  assert.match(
    topology,
    /const remoto = c \? await findDeviceCrossScope\(c\.origem === e\.id \? c\.destino : c\.origem\) : null;/
  );
});

/* Documentar um enlace só existia pelo caminho da porta: abrir o equipamento,
   achar uma porta livre, editar. Quem estava olhando a rede inteira — a lista
   de enlaces do "Gerenciar rede" — via todos eles e não tinha por onde
   acrescentar; o rodapé da própria tabela mandava a pessoa embora, para o
   equipamento. Agora as duas pontas são escolhidas ali mesmo. */

test("a lista de enlaces tem por onde inserir", () => {
  assert.match(topology, /async function openNovoEnlace\(aoGravar\)/);
  assert.match(topology, /data-newconn/);
  assert.match(topology, /inserirEnlace\.onclick = \(\) => openNovoEnlace\(paint\);/);
  // O botão respeita a mesma ação da criação pela porta.
  assert.match(topology, /data-newconn\n\s+\$\{podeCriarEnlace\(\) \? "" :/);
});

test("o inseridor oferece só porta sem enlace e recusa ponta contra si mesma", () => {
  // Mesma regra de disponibilidade do editor da porta, e não uma segunda.
  assert.match(topology, /const lista = selEq\.value \? await portasDisponiveis\(selEq\.value, null\) : \[\];/);
  assert.match(topology, /if \(idA === idB\) return toast\("Pontas iguais"/);
  // A lista é montada antes do clique: a ocupação é reconferida na gravação.
  assert.match(topology, /if \(NOC\.portConnection\(idA, portaA\) \|\| NOC\.portConnection\(idB, portaB\)\)/);
});
