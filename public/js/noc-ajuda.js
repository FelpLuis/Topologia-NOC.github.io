/* ============================================================
   UPDOWN NOC — conteúdo da Ajuda (perguntas frequentes)
   Carregado sob demanda pelo botão Ajuda da barra (noc-ui.js):
   quem nunca abre a Ajuda não baixa este arquivo.

   Fonte atual: guia "Processo de atendimento" do setor
   (artifact Atendimento UpDown). Para acrescentar conteúdo, crie
   uma categoria nova ou uma pergunta nova dentro de uma existente.

   Cada categoria: { id, nome, perguntas: [...] }
   Cada pergunta:  { q: "pergunta", a: "resposta em HTML", tags: "palavras extras para a busca" }
   `faixas` (opcional) desenha uma tabela de faixas coloridas:
       [[valor, rótulo, cor, descrição], ...]
   O HTML é escrito aqui mesmo, pela equipe — nunca vem de usuário.
   ============================================================ */
window.NOC_AJUDA = {
  titulo: "Perguntas frequentes",
  fonte: "Processo de atendimento UpDown",
  categorias: [
    {
      id: "processo",
      nome: "Processo de atendimento",
      perguntas: [
        {
          q: "Quais são as 7 etapas do atendimento?",
          tags: "roteiro passo a passo onboarding",
          a: `<ol>
            <li><b>Atendimento encantador:</b> receba e ouça o cliente.</li>
            <li><b>Verificação no sistema:</b> confira cadastro, recorrência, sinal e logs no IXC.</li>
            <li><b>Entendimento da solicitação:</b> identifique o tipo de solicitação e confirme com o cliente.</li>
            <li><b>Equipamento:</b> firmware, canal, largura, SSID, cabo, RSSI, MCS e mesh.</li>
            <li><b>Orientação e testes:</b> o cliente testa. Não resolveu: analistas.</li>
            <li><b>Atendimento / abertura de O.S.:</b> registre no IXC e abra O.S. se precisar.</li>
            <li><b>Final do atendimento encantador:</b> confirme se resolveu, tire dúvidas e peça a avaliação do seu atendimento.</li>
          </ol>`
        },
        {
          q: "Como começar o atendimento (atendimento encantador)?",
          tags: "etapa 1 cordialidade ouvir áudio",
          a: `<ul>
            <li>Receba o cliente com cordialidade e atenção.</li>
            <li>Ouça o cliente. <b>Se ele manda áudio, responda em áudio.</b></li>
            <li>Use as mesmas palavras que ele usou para descrever o problema.</li>
            <li>Demonstre disposição em <b>resolver</b> o problema.</li>
          </ul>`
        },
        {
          q: "O que verificar no sistema antes de atender?",
          tags: "etapa 2 ixc cadastro plano bloqueado fatura",
          a: `<p>No <b>cadastro do cliente no IXC</b>, verifique:</p>
          <ul>
            <li>Plano atual.</li>
            <li>Situação cadastral: bloqueado, fatura em atraso.</li>
            <li>Atendimentos e ordens de serviço <b>recorrentes</b> com o mesmo problema.</li>
            <li>Sinal da fibra (status <b>Online</b>) e logs do equipamento.</li>
          </ul>`
        },
        {
          q: "Como entender o que o cliente está pedindo?",
          tags: "etapa 3 tipo de solicitação instabilidade sem conexão boleto mudança dúvida",
          a: `<p>Identifique o tipo de solicitação:</p>
          <ul>
            <li>Instabilidades em geral</li>
            <li>Sem conexão</li>
            <li>Boletos</li>
            <li>Mudança de endereço</li>
            <li>Dúvidas em geral</li>
          </ul>
          <p>Depois, <b>repita com as suas palavras</b> o que entendeu para confirmar com o cliente, principalmente em ligação.</p>`
        },
        {
          q: "O que fazer depois de verificar e ajustar o equipamento?",
          tags: "etapa 5 orientação testes dicas",
          a: `<ul>
            <li>Peça para o cliente <b>testar a conexão em todos os aparelhos e cômodos</b> da residência.</li>
            <li>Deixe dicas ao cliente (ex.: desligar o equipamento a cada 7 dias para garantir o melhor desempenho).</li>
            <li>Oriente sobre o DownDetector e o aplicativo do cliente.</li>
            <li>Se não resolver, escalone para os <b>analistas</b>.</li>
          </ul>`
        },
        {
          q: "Como encerrar o atendimento?",
          tags: "etapa 7 final avaliação despedida",
          a: `<ul>
            <li>Valide se foi resolvido ou se foi aberta a O.S.</li>
            <li>Solicite a avaliação do <b>seu atendimento</b>.</li>
            <li>Pergunte se pode ajudar em algo mais; se não, despeça-se cordialmente.</li>
          </ul>`
        },
        {
          q: "Boas práticas com o cliente",
          tags: "sempre comunicação linguagem",
          a: `<ul>
            <li>Responda no mesmo formato (áudio → áudio).</li>
            <li>Fale simples, sem termo técnico.</li>
            <li>Confirme o que entendeu antes de agir.</li>
            <li>Diga sempre o próximo passo ao cliente.</li>
            <li>Registre tudo no IXC.</li>
            <li>Peça a avaliação do seu atendimento no final.</li>
          </ul>`
        },
        {
          q: "Quais ferramentas o atendimento usa?",
          tags: "ixc opa suite whatsapp ligação downdetector",
          a: `<ul>
            <li><b>IXC:</b> cadastro, financeiro, logs e O.S.</li>
            <li><b>Opa Suite:</b> WhatsApp e ligações.</li>
            <li><b>DownDetector:</b> quedas de serviços externos.</li>
          </ul>`
        }
      ]
    },
    {
      id: "encaminhar",
      nome: "Para onde encaminhar",
      perguntas: [
        {
          q: "Para quem encaminho cada situação?",
          tags: "escalonar setor financeiro analista visita técnica",
          faixas: [
            ["Bloqueado por motivo financeiro", "Setor financeiro", "#E1254B"],
            ["Recorrente (2 chamados do mesmo problema no mês)", "Analista acompanha", "#E0A00B"],
            ["Luz vermelha (LOS), LOSI ou sinal crítico", "O.S. de visita técnica", "#E1254B"],
            ["Não resolveu nos testes", "Analistas", "#9B00FF"],
            ["Boleto ou mudança de endereço", "O próprio setor resolve", "#1FA971"]
          ],
          a: ``
        },
        {
          q: "Cliente bloqueado por motivo financeiro: o que fazer?",
          tags: "bloqueio fatura atraso",
          a: `<p>Escalone para o <b>setor financeiro</b> e registre a tratativa no IXC.</p>`
        },
        {
          q: "O cliente já abriu chamado do mesmo problema. E agora?",
          tags: "recorrente recorrência reincidente",
          a: `<p><b>2 chamados do mesmo problema no mês:</b> repasse para o <b>analista acompanhar</b> e siga o atendimento normalmente.</p>`
        },
        {
          q: "Quando abrir O.S. de visita técnica?",
          tags: "ordem de serviço visita técnico",
          a: `<ul>
            <li>Sinal da fibra <b>crítico</b> (-28 dBm ou pior).</li>
            <li>Logs de <b>LOS</b> ou <b>LOSI</b>.</li>
            <li>Sem conexão e não voltou após conferir energia, botão e cabos.</li>
            <li>Cliente reclama da velocidade ou não tem computador com cabo para testar.</li>
          </ul>`
        }
      ]
    },
    {
      id: "fibra",
      nome: "Sinal da fibra e logs",
      perguntas: [
        {
          q: "Como ler o sinal da fibra (dBm)?",
          tags: "potência óptica dbm regular irregular crítico cto",
          a: `<p>O sinal é um número negativo: <b>quanto mais perto de zero, mais forte</b>. Exemplo: -20 é melhor que -26.</p>`,
          faixas: [
            ["-19 a -24 dBm", "Regular", "#1FA971", "Sinal bom. Exemplos: -20, -22, -24."],
            ["-25 a -27 dBm", "Irregular", "#E0A00B", "Sinal fraco, pode oscilar. Compare com o sinal da caixa (CTO)."],
            ["-28 dBm ou pior", "Crítico", "#E1254B", "Sinal muito fraco, precisa de correção: abrir O.S. de visita."]
          ],
          nota: "Valide se o problema é somente do cliente ou da CTO."
        },
        {
          q: "O que significa cada log da ONU?",
          tags: "reboot dying gasp los losi lofi sfi alerta",
          faixas: [
            ["REBOOT", "Reiniciado", "#0B6FEE", "Equipamento foi reiniciado."],
            ["DYING GASP", "Sem energia", "#F26B1D", "Falta de luz, tomada desligada ou fonte/equipamento com defeito. Confirme energia, tomada, botão e fonte. Persistiu: visita técnica."],
            ["LOS", "Sem conexão", "#E1254B", "Cabo rompido, conector solto ou CTO sem sinal. Abrir visita técnica. Validar se é só do cliente ou da CTO."],
            ["LOSI", "Interferência", "#128C8C", "Sem conexão, sinal caindo a todo momento (conector, sinal, equipamento, emenda ou CTO). Abrir visita técnica."],
            ["LOFI", "Sem comunicação", "#E0A00B", "Recebe sinal mas não mantém a comunicação; ligado a sinal crítico. Verificar potência; fora do padrão: visita."],
            ["SFI", "Sinal degradado", "#9B00FF", "Conector sujo, danificado ou emenda malfeita. Verificar potência, conectores, fibra, emendas e CTO."]
          ],
          a: ``
        },
        {
          q: "O que significam os logs do concentrador?",
          tags: "adm-request user-request lost-carrier pppoe radius",
          faixas: [
            ["ADM-REQUEST", "Suporte", "#7A1FD6", "Equipamento foi reiniciado pelo suporte."],
            ["USER-REQUEST", "Cliente", "#0BBBEF", "Equipamento foi reiniciado pelo cliente."],
            ["LOST-CARRIER", "Incidente", "#E1254B", "Incidente interno ou externo."]
          ],
          a: ``,
          nota: "Se o diagnóstico da fibra do cliente estiver como Dying Gasp, o diagnóstico detalhado mostra se foi incidente ou User-Request."
        },
        {
          q: "Como é um log com problema recorrente?",
          tags: "exemplo motivo losi",
          a: `<p>Observe a <b>recorrência dos alertas</b>. Exemplo de LOSI repetido no mesmo dia:</p>
          <pre class="help-code">Motivo2: 2026-09-21 10:37:00 2026-09-21 10:39:40 LOSi
Motivo3: 2026-09-21 10:39:51 2026-09-21 11:22:27 LOSi
Motivo4: 2026-09-21 11:22:37 2026-09-21 12:10:12 LOSi
Motivo5: 2026-09-21 12:10:44 2026-09-21 13:01:08 LOSi</pre>`
        }
      ]
    },
    {
      id: "problemas",
      nome: "Instabilidade e sem conexão",
      perguntas: [
        {
          q: "Cliente com instabilidade: o que perguntar e o que fazer?",
          tags: "lenta caindo oscilando travando",
          a: `<p><b>O que perguntar</b></p>
          <ul>
            <li>Em qual cômodo acontece (sala, quarto, cozinha).</li>
            <li>Qual aplicativo está acessando (redes sociais, bancos, jogos).</li>
            <li>Em qual aparelho acontece (TV, celular, computador).</li>
            <li>Desde quando e em quais períodos (manhã, tarde, noite).</li>
          </ul>
          <p><b>O que fazer</b></p>
          <ul>
            <li>Conferir a situação cadastral do cliente.</li>
            <li>Verificar o sinal da fibra e os logs da ONU.</li>
            <li>Conferir a configuração e a conexão dos equipamentos.</li>
            <li>Consultar o DownDetector para ver se o aplicativo ou serviço está com instabilidade.</li>
          </ul>`
        },
        {
          q: "Cliente sem conexão: o que perguntar e o que fazer?",
          tags: "sem internet caiu luz vermelha los",
          a: `<p><b>O que perguntar</b></p>
          <ul>
            <li>A luz vermelha (LOS) está piscando no equipamento?</li>
            <li>A rede Wi-Fi aparece na lista para conectar?</li>
            <li>O equipamento está na tomada e com o botão ligado?</li>
            <li>Houve queda de energia ou obra no local?</li>
            <li>Algum cabo está solto, rompido ou danificado?</li>
          </ul>
          <p><b>O que fazer</b></p>
          <ul>
            <li>Conferir a situação cadastral, o sinal da fibra e os logs da ONU.</li>
            <li>Voltou: siga para orientação e testes. Não voltou: abra O.S. de visita.</li>
          </ul>`
        },
        {
          q: "O cliente diz que a internet está lenta. Como testar a velocidade?",
          tags: "speedtest teste de velocidade cabo wifi gigabit",
          a: `<ol>
            <li><b>Pergunte onde testou:</b> celular, tablet, notebook ou computador? Pelo cabo ou pelo Wi-Fi?</li>
            <li><b>Verifique antes:</b> sinal da fibra, logs e equipamento. Corrija o que estiver errado.</li>
            <li><b>Peça um novo teste</b> no mesmo aparelho, em <b>speedtest.net</b>, com os outros aparelhos desligados da internet.</li>
            <li>Se foi no celular, peça para testar no <b>computador com cabo</b>. Computador e cabo precisam ser de <b>1000Mbps</b> (gigabit).</li>
            <li>Se ele reclamar da velocidade ou não tiver computador com cabo, <b>ofereça visita técnica</b>.</li>
          </ol>`
        },
        {
          q: "Por que o Wi-Fi fica mais lento que o cabo?",
          tags: "explicar cliente distância parede 5ghz 2.4ghz",
          a: `<ul>
            <li><b>Aparelho:</b> cada um tem um limite de velocidade. Celular antigo é mais lento.</li>
            <li><b>Distância:</b> longe do equipamento, o sinal fica fraco.</li>
            <li><b>Paredes:</b> parede grossa, laje, espelho e móveis grandes atrapalham.</li>
            <li><b>Outros aparelhos:</b> micro-ondas, caixa de som e o Wi-Fi dos vizinhos atrapalham.</li>
            <li><b>Lugar do equipamento:</b> alto, aberto e no meio da casa.</li>
            <li><b>5GHz</b> é mais rápido, mas alcança menos. <b>2.4GHz</b> vai mais longe, mas é mais lento.</li>
          </ul>
          <p class="help-fala">“A internet chega completa no equipamento. No Wi-Fi ela perde força com a distância, as paredes e o aparelho. Por isso, o teste certo é no computador com cabo.”</p>`
        },
        {
          q: "IPTV travando: como atender?",
          tags: "iptv tv aplicativo travando fornecedor",
          a: `<ol>
            <li><b>Descubra onde trava:</b> “Em qual aplicativo a internet falha?” Peça uma foto da tela e pesquise o nome.</li>
            <li><b>Verifique a conexão:</b> sinal, logs e equipamento. O aparelho do IPTV está no cabo ou no Wi-Fi? O melhor é no cabo.</li>
            <li><b>Teste outros aplicativos:</b> explique que o IPTV pode travar por motivos que não são da internet. “Pode testar o YouTube ou a Netflix nesse aparelho?”</li>
            <li><b>Encaminhe para quem vende o IPTV:</b> se YouTube e Netflix funcionam, a internet está boa. Peça para o cliente falar com o fornecedor e ver se há atualização do aparelho ou do aplicativo.</li>
          </ol>`
        },
        {
          q: "Como usar o DownDetector?",
          tags: "downdetector aplicativo fora do ar whatsapp instagram netflix",
          a: `<p>Use quando a internet está boa, mas <b>um aplicativo ou site</b> não funciona (WhatsApp, Instagram, Netflix, jogos, bancos).</p>
          <ol>
            <li>Abra <a href="https://downdetector.com.br" target="_blank" rel="noopener">downdetector.com.br</a> e pesquise o aplicativo.</li>
            <li>Leia as cores: <span class="help-dot" style="--d:#1FA971"></span><b>verde</b> normal · <span class="help-dot" style="--d:#E0A00B"></span><b>amarelo/laranja</b> possíveis problemas · <span class="help-dot" style="--d:#E1254B"></span><b>vermelho</b> problema no aplicativo.</li>
            <li>No gráfico, a faixa cinza é o normal. Um pico bem acima dela nas últimas horas indica problema agora.</li>
          </ol>
          <p class="help-fala">“O [aplicativo] está com falha agora para muitas pessoas, não é a sua internet. Quando eles resolverem, volta ao normal.”</p>
          <p>Se estiver normal, siga o processo e verifique a conexão.</p>`
        }
      ]
    },
    {
      id: "equipamento",
      nome: "Equipamento e Wi-Fi",
      perguntas: [
        {
          q: "Qual a versão de firmware mais recente?",
          tags: "firmware atualização f6201b f670l wifi 6 v9",
          a: `<ul>
            <li><b>Wi-Fi 6 (F6201B):</b> última versão <code>P7N9.bin</code></li>
            <li><b>V9 (F670L):</b> última versão <code>P3N10.bin</code></li>
          </ul>`
        },
        {
          q: "Qual canal usar no 2.4GHz e no 5GHz?",
          tags: "canal wifi interferência varredura",
          a: `<p>Verifique de acordo com a varredura do roteador e escolha os canais mais livres (com menos redes).</p>
          <ul>
            <li><b>2.4GHz:</b> entre <b>4 e 9</b>. Evite 1 a 3 e 10 a 12: alguns aparelhos não os reconhecem e ficam instáveis.</li>
            <li><b>5GHz:</b> entre <b>36 e 64</b>. Canais acima de 100 podem causar falhas de conexão.</li>
          </ul>
          <p class="dim">Onde: Configuração Global WLAN → 2.4GHz / 5GHz → Canal.</p>`
        },
        {
          q: "Qual largura de banda configurar?",
          tags: "largura de banda mhz 40 80 160",
          a: `<ul>
            <li><b>Rede 2.4GHz:</b> 40MHz</li>
            <li><b>Rede 5GHz:</b> 80MHz (V9) ou 160MHz (Wi-Fi 6)</li>
          </ul>
          <p class="dim">Onde: Configuração Global WLAN → 2.4GHz / 5GHz → Largura da Banda.</p>`
        },
        {
          q: "Qual SSID é 2.4GHz e qual é 5GHz?",
          tags: "ssid rede wifi clientes conectados",
          a: `<ul>
            <li><b>SSID 1 a 4:</b> 2.4GHz</li>
            <li><b>SSID 5 a 7:</b> 5GHz</li>
          </ul>
          <p>No aparelho conectado, o campo <b>SSID</b> mostra em qual rede ele está.</p>`
        },
        {
          q: "Como ver se o cabo de rede está bom?",
          tags: "lan cabo velocidade crimpagem 10 100 1000 mbps",
          a: `<p>Veja se há cabo conectado e a velocidade dele no campo <b>Estado</b> da LAN:</p>`,
          faixas: [
            ["10Mbps", "Ruim", "#E1254B", "Crimpagem malfeita, cabo danificado ou mal encaixado no roteador."],
            ["100Mbps", "Limitado", "#E0A00B", "Limite do equipamento ou do cabo."],
            ["1000Mbps", "Máxima", "#1FA971", ""]
          ]
        },
        {
          q: "Como ler o RSSI (força do sinal Wi-Fi)?",
          tags: "rssi sinal wifi distância aparelho",
          a: `<p>Mostra se o sinal Wi-Fi chega forte no aparelho. <b>Quanto mais perto de 0, melhor.</b> Aparece na lista de aparelhos conectados.</p>`,
          faixas: [
            ["-30 a -50", "Excelente", "#1FA971", "Sinal forte. Funciona bem para tudo."],
            ["-51 a -65", "Bom", "#5FAE2E", "Navegação, chamadas e vídeos funcionam bem."],
            ["-66 a -75", "Aceitável", "#C9A200", "Pode travar de vez em quando."],
            ["-76 a -85", "Fraco", "#F26B1D", "Lentidão e quedas."],
            ["Abaixo de -85", "Muito ruim", "#E1254B", "Cai toda hora ou nem conecta."]
          ]
        },
        {
          q: "Como ler o MCS (velocidade da conexão Wi-Fi)?",
          tags: "mcs velocidade wifi",
          a: `<p>Mostra a velocidade do aparelho no Wi-Fi. <b>Quanto maior o número, melhor.</b></p>`,
          faixas: [
            ["0 a 3", "Muito baixo", "#E1254B", "Aparelho longe ou com muita parede. Aproximar do equipamento."],
            ["4 a 6", "Baixo", "#F26B1D", "Mudar o equipamento de lugar ou afastar de outros aparelhos."],
            ["7 a 9", "Bom", "#C9A200", "Navegação, chamadas e vídeos funcionam bem."],
            ["10 a 12", "Muito bom", "#5FAE2E", "Ótimo, mesmo com vários aparelhos conectados."],
            ["13 a 15", "Excelente", "#1FA971", "Melhor velocidade possível."]
          ],
          nota: "Sinal forte mas MCS baixo? Pode ser interferência de outras redes ou aparelho antigo."
        },
        {
          q: "Como verificar o mesh do cliente?",
          tags: "mesh wps roaming topologia controller agent",
          a: `<ol>
            <li><b>Mesh Wi-Fi ativo:</b> aba Mesh Wi-Fi → Ativar: <b>Ligado</b>. Desligado, nenhum mesh sincroniza. Só altere os limites de Roaming se a função não estiver funcionando como esperado.</li>
            <li><b>WPS ativo:</b> necessário com mesh ou impressora via Wi-Fi. Aba WPS → <b>Modo WPS: PBC</b> no 2.4GHz e no 5GHz.</li>
            <li><b>Topologia:</b> mostra o equipamento principal e os mesh ligados a ele. No Wi-Fi 6 (F6201B), clique no mesh para ver detalhes. Na versão antiga, o <b>Controller</b> é o principal e cada <b>Agent</b> é um mesh (passe o mouse para ver).</li>
            <li><b>Mesh por cabo:</b> ícone de cabo; no mesh aparece <b>Link Type: ETH</b> e o <b>Link Speed</b> (10 ruim, 100 limitado, 1000 máxima).</li>
            <li><b>Mesh por Wi-Fi:</b> ícone de Wi-Fi; o <b>RSSI</b> do mesh é o sinal que chega do principal. <b>Limite máximo aceitável: -65.</b> Abaixo disso, aproxime o mesh ou ligue por cabo.</li>
          </ol>`
        }
      ]
    },
    {
      id: "os",
      nome: "O.S. e mudança de endereço",
      perguntas: [
        {
          q: "Como registrar o atendimento e abrir a O.S.?",
          tags: "etapa 6 ordem de serviço registro ixc logística",
          a: `<ul>
            <li>Registre a tratativa no IXC (principalmente se for ligação).</li>
            <li>Abra a O.S. descrevendo o que ocorre e uma possível resolução, de forma objetiva.</li>
            <li>Registre o que foi verificado: <b>sintoma relatado</b>, <b>logs recorrentes e sinal da fibra</b> e <b>o que já foi testado</b> com o cliente.</li>
            <li>Confirme a data da visita com a <b>Logística</b>.</li>
          </ul>`
        },
        {
          q: "A visita ficou para depois de 2 dias. O que falar ao cliente?",
          tags: "agenda encaixe reagendamento prazo",
          a: `<p class="help-fala">“Se surgir um encaixe por desistência ou reagendamento de outro cliente, entraremos em contato para avisar.”</p>`
        },
        {
          q: "Como fazer uma mudança de endereço?",
          tags: "mudança endereço cto taxa cabo",
          a: `<ol>
            <li><b>Peça o endereço novo:</b> CEP, rua, número, complemento, bairro e ponto de referência. Veja se tem <b>caixa (CTO)</b> que atenda o local; se não tiver, fale com o gestor.</li>
            <li><b>Marque a data:</b> são <b>4 mudanças por dia</b>. Avise que há uma <b>taxa do cabo</b>.</li>
            <li><b>Avise o que levar:</b> ONT, roteadores, suportes de parede, fontes e cabos de rede.</li>
            <li><b>Abra a O.S.</b> para a equipe externa e mude o endereço <b>no cadastro, no contrato e no login</b>.</li>
          </ol>`
        }
      ]
    }
  ]
};
