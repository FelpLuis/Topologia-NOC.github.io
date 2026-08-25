(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;
  /* Mês, dia e hora aqui são sempre os de São Paulo. O cursor do calendário é
     um mês civil ({ano, mes}) em vez de um Date porque "que mês estou vendo" é
     pergunta de calendário: tirar o mês de um Date faz a resposta depender do
     fuso do computador, e a grade escorregava um dia inteiro num telão em UTC.
     Cada dia da grade vira instante uma vez só, em `diaSP`. */
  const pad = n => String(n).padStart(2,"0");
  const mesDe = (data) => { const p = TEMPO.partes(data); return { ano: p.ano, mes: p.mes }; };
  const somarMeses = ({ ano, mes }, delta) => {
    const total = ano * 12 + (mes - 1) + delta;
    return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
  };
  const diaSP = (ano, mes, dia) => TEMPO.deInput(`${ano}-${pad(mes)}-${pad(dia)}T00:00`);
  const primeiroDoMes = ({ ano, mes }) => diaSP(ano, mes, 1);

  const state = { cursor: mesDe(new Date()), data: null, visible: new Set(), events: [] };

  const monthRange = () => ({
    start: primeiroDoMes(state.cursor).toISOString(),
    end: primeiroDoMes(somarMeses(state.cursor, 1)).toISOString()
  });
  const localInput = (value) => TEMPO.paraInput(value || new Date(Date.now() + 3600000));
  const ownerKey = e => e.owner_type === "sector" ? `sector:${e.sector_id}` : "user";
  const colorOf = e => e.sector_color || "#06b6d4";
  const filtered = () => state.events.filter(e => state.visible.has(ownerKey(e)));

  const eventDate = (event, field) => {
    const value = event[field];
    // Dia inteiro é data de calendário: o compromisso começa à meia-noite de
    // São Paulo, e não à meia-noite de onde o navegador acha que está.
    const d = event.all_day
      ? diaSP(...String(value).slice(0, 10).split("-").map(Number))
      : TEMPO.instante(value);
    return d || new Date(NaN);
  };

  async function load() {
    const range = monthRange();
    state.data = await NOC.api(`/api/agenda?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`);
    state.events = state.data.events || [];
    if (!state.visible.size) {
      state.visible.add("user");
      (state.data.sectors || []).forEach(s => state.visible.add(`sector:${s.id}`));
    }
    render();
  }

  function renderFilters() {
    const sectors = state.data.sectors || [];
    const sectorKeys = sectors.map(sector => `sector:${sector.id}`);
    const personalActive = state.visible.has("user");
    const sectorActive = sectorKeys.some(key => state.visible.has(key));
    const sectorNames = sectors.map(sector => sector.name).join(", ");
    $("#calendarFilters").innerHTML = `<span class="dim">Exibir:</span>
      <button class="chip" data-agenda-kind="personal" aria-pressed="${personalActive}" type="button">
        <i class="dot" style="background:#06b6d4"></i>Minha agenda
      </button>
      ${sectors.length ? `<button class="chip" data-agenda-kind="sector" aria-pressed="${sectorActive}" type="button" title="${esc(sectorNames)}">
        <i class="dot" style="background:${esc(sectors[0].color || "#2563eb")}"></i>Agenda do setor${sectors.length > 1 ? ` <span class="count">${sectors.length}</span>` : ""}
      </button>` : '<span class="badge">Nenhum setor vinculado</span>'}`;
    $$('[data-agenda-kind]').forEach(button => button.onclick = () => {
      const personal = button.dataset.agendaKind === "personal";
      const currentlyActive = personal ? state.visible.has("user") : sectorKeys.some(key => state.visible.has(key));
      const otherActive = personal ? sectorKeys.some(key => state.visible.has(key)) : state.visible.has("user");
      if (currentlyActive && !otherActive) {
        toast("Mantenha uma agenda selecionada", { text: "Escolha a agenda pessoal, a agenda do setor ou as duas.", type: "info" });
        return;
      }
      if (personal) {
        if (currentlyActive) state.visible.delete("user"); else state.visible.add("user");
      } else {
        sectorKeys.forEach(key => currentlyActive ? state.visible.delete(key) : state.visible.add(key));
      }
      renderFilters(); renderCalendar(); renderUpcoming();
    });
    const imported = state.data.import || {};
    $("#importState").innerHTML = `<span class="badge ${Number(imported.total) ? "badge-ok" : ""}">${icon("calendar")} ${Number(imported.total || 0)} importado(s)</span>
      <button class="btn btn-sm" data-import-agenda type="button">Importar .ics</button>`;
    $("[data-import-agenda]")?.addEventListener("click", UI.openAgendaImport);
  }

  function renderCalendar() {
    const title = TEMPO.fmt(primeiroDoMes(state.cursor),{month:"long",year:"numeric"});
    $("#monthTitle").textContent = title.charAt(0).toUpperCase()+title.slice(1);
    const events = filtered();
    $("#eventCount").textContent = `${events.length} compromisso${events.length===1?"":"s"}`;
    /* A contagem de dias corre em UTC de propósito: aqui só interessa a
       sequência do calendário (dia 1, 2, 3…), que não muda com fuso. A hora
       real de cada dia vem depois, de `diaSP`. */
    const DIA_MS = 86400000;
    const primeiro = Date.UTC(state.cursor.ano, state.cursor.mes-1, 1);
    const gridStart = primeiro - new Date(primeiro).getUTCDay()*DIA_MS;
    const hoje = TEMPO.chaveDia(new Date());
    $("#calendarGrid").innerHTML = Array.from({length:42},(_,i) => {
      const civil = new Date(gridStart + i*DIA_MS);
      const seguinte = new Date(gridStart + (i+1)*DIA_MS);
      const numero = civil.getUTCDate();
      const day = diaSP(civil.getUTCFullYear(), civil.getUTCMonth()+1, numero);
      const next = diaSP(seguinte.getUTCFullYear(), seguinte.getUTCMonth()+1, seguinte.getUTCDate());
      const list = events.filter(e => eventDate(e,"start")<next && eventDate(e,"end")>day).slice(0,4);
      const sameMonth = civil.getUTCMonth()===state.cursor.mes-1;
      const isToday = TEMPO.chaveDia(day)===hoje;
      return `<div class="calendar-day ${sameMonth?"":"is-outside"} ${isToday?"is-today":""}" data-day="${day.toISOString()}">
        <span class="day-number">${numero}</span>
        ${list.map(e=>{
          const rotulo=(e.all_day?"":TEMPO.hora(eventDate(e,"start"))+" · ")+e.title;
          // `aria-label` porque no celular o texto do botão fica visualmente
          // invisível (a célula não tem altura para um rótulo por evento) —
          // sem ele, o leitor de tela também não teria o que anunciar.
          return `<button class="day-event" style="--event-color:${esc(colorOf(e))}" data-event="${esc(e.id)}" title="${esc(e.title)}" aria-label="${esc(rotulo)}">${esc(rotulo)}</button>`;
        }).join("")}
        ${events.filter(e=>eventDate(e,"start")<next&&eventDate(e,"end")>day).length>4?'<small class="dim">mais compromissos…</small>':""}
      </div>`;
    }).join("");
    $$('[data-event]').forEach(b=>b.onclick=e=>{e.stopPropagation();openEvent(state.events.find(x=>String(x.id)===b.dataset.event));});
    $$('[data-day]').forEach(day=>day.onclick=()=>openEvent(null,new Date(day.dataset.day)));
  }

  function renderUpcoming() {
    const list=filtered().filter(e=>eventDate(e,"end")>=new Date()).slice(0,20);
    $("#upcomingList").innerHTML=list.length?list.map(e=>{
      const d=eventDate(e,"start");
      return `<button class="upcoming-item" style="--event-color:${esc(colorOf(e))}" data-upcoming="${esc(e.id)}" type="button">
        <span class="upcoming-date"><b>${TEMPO.partes(d).dia}</b><small>${TEMPO.fmt(d,{month:"short"}).replace(".","")}</small></span>
        <span style="text-align:left"><b>${esc(e.title)}</b><br><small class="dim">${e.all_day?"Dia todo":TEMPO.hora(d)}${e.location?" · "+esc(e.location):""}</small><br>
        <span class="calendar-owner" style="--event-color:${esc(colorOf(e))}"><i></i>${esc(e.sector_name||"Minha agenda")}</span></span>
      </button>`;
    }).join(""):`<div class="empty"><span class="empty-icon">${icon("calendar")}</span><b>Nenhum compromisso próximo</b><p>Use “Novo compromisso” para começar.</p></div>`;
    $$('[data-upcoming]').forEach(b=>b.onclick=()=>openEvent(state.events.find(e=>String(e.id)===b.dataset.upcoming)));
  }

  function render(){renderFilters();renderCalendar();renderUpcoming();}

  function openEvent(event=null,day=null){
    if(event&&!event.can_edit)return openDetails(event);
    // Compromisso novo cai na hora cheia seguinte — a de Brasília, que é a que
    // o operador tem em mente ao clicar num dia do calendário.
    const proximaHora=Math.min(23,TEMPO.partes(new Date()).hora+1);
    const start=event?TEMPO.instante(event.start)
      :TEMPO.deInput(`${TEMPO.chaveDia(day||new Date())}T${pad(proximaHora)}:00`);
    const end=event?TEMPO.instante(event.end):new Date(start.getTime()+3600000);
    const owners=[{type:"user",id:"",name:"Minha agenda"},...(state.data.sectors||[]).map(s=>({type:"sector",id:s.id,name:s.name}))];
    modal({wide:true,labelledBy:"agendaEventTitle",html:`
      <div class="modal-head"><div><span class="kicker">${event?"Editar":"Novo"}</span><h2 id="agendaEventTitle">${event?esc(event.title):"Novo compromisso"}</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
      <div class="modal-body stack">
        <div class="field"><label for="eventTitle">Título</label><input class="input" id="eventTitle" maxlength="300" value="${esc(event?.title||"")}" autofocus></div>
        <div class="agenda-form-grid"><div class="field"><label for="eventOwner">Agenda</label><select class="select" id="eventOwner" ${event?"disabled":""}>${owners.map(o=>`<option value="${o.type}:${o.id}" ${(event?.owner_type===o.type&&String(event?.sector_id||"")===String(o.id))?"selected":""}>${esc(o.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="eventLocation">Local</label><input class="input" id="eventLocation" maxlength="500" value="${esc(event?.location||"")}"></div></div>
        <div class="agenda-form-grid"><div class="field"><label for="eventStart">Início</label><input class="input" id="eventStart" type="datetime-local" value="${localInput(start)}"></div><div class="field"><label for="eventEnd">Término</label><input class="input" id="eventEnd" type="datetime-local" value="${localInput(end)}"></div></div>
        <label class="row" style="gap:8px"><input type="checkbox" id="eventAllDay" ${event?.all_day?"checked":""}> Compromisso de dia inteiro</label>
        <div class="field"><label for="eventDescription">Descrição</label><textarea class="textarea" id="eventDescription" rows="3">${esc(event?.description||"")}</textarea></div>
        <div class="agenda-alerts"><b>${icon("bell")} Alerta em popup</b><label><input type="checkbox" id="alertPopup" ${event?.alert_popup!==false?"checked":""}> Ativo</label><label class="row" style="gap:6px"><input class="input" style="width:80px" id="alertMinutes" type="number" min="0" max="1440" value="${event?.alert_minutes??10}"> min antes</label></div>
        <span class="field-error" id="eventError" hidden></span>
      </div>
      <div class="modal-foot"><span>${event?.sync_error?`<small class="dim">${icon("alert")} ${esc(event.sync_error)}</small>`:""}</span><span class="row">${event?.can_delete?'<button class="btn btn-danger" data-delete type="button">Excluir</button>':""}<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Salvar</button></span></div>`,
      onMount:(host,close)=>{
        $("[data-save]",host).onclick=async()=>{
          const owner=$("#eventOwner",host).value.split(":"), startValue=TEMPO.deInput($("#eventStart",host).value), endValue=TEMPO.deInput($("#eventEnd",host).value);
          const error=$("#eventError",host); if(!$("#eventTitle",host).value.trim()||!startValue||!endValue||endValue<=startValue){error.hidden=false;error.textContent="Informe título e um término posterior ao início.";return}
          const payload={title:$("#eventTitle",host).value.trim(),owner_type:owner[0],sector_id:owner[1]?Number(owner[1]):null,location:$("#eventLocation",host).value.trim(),description:$("#eventDescription",host).value.trim(),start:startValue.toISOString(),end:endValue.toISOString(),all_day:$("#eventAllDay",host).checked,alert_email:false,alert_popup:$("#alertPopup",host).checked,alert_minutes:Number($("#alertMinutes",host).value)};
          if(payload.alert_popup&&"Notification" in window&&Notification.permission==="default")await Notification.requestPermission();
          try{await NOC.api(event?`/api/agenda/events/${event.id}`:"/api/agenda/events",{method:event?"PATCH":"POST",body:JSON.stringify(payload)});close();await load();toast(event?"Compromisso atualizado":"Compromisso criado",{text:"O alerta em popup foi configurado.",type:"ok"});}
          catch(err){error.hidden=false;error.textContent=err.message}
        };
        $("[data-delete]",host)?.addEventListener("click",()=>askConfirm({title:"Excluir compromisso?",text:"O compromisso será removido somente do NOC. A agenda importada permanece somente leitura.",confirmLabel:"Excluir",danger:true,onConfirm:async()=>{try{await NOC.api(`/api/agenda/events/${event.id}`,{method:"DELETE"});close();await load();toast("Compromisso excluído",{type:"ok"})}catch(err){toast("Não foi possível excluir",{text:err.message,type:"danger"})}}}));
      }
    });
  }

  function openDetails(e){const start=eventDate(e,"start"),end=eventDate(e,"end");const when=e.all_day?`${TEMPO.data(start)} · dia inteiro`:`${TEMPO.dataHora(start)} até ${TEMPO.dataHora(end)}`;modal({labelledBy:"eventDetailsTitle",html:`<div class="modal-head"><div><span class="kicker">${esc(e.sector_name||"Agenda pessoal")}</span><h2 id="eventDetailsTitle">${esc(e.title)}</h2></div><button class="btn btn-ghost btn-icon" data-close>${icon("close")}</button></div><div class="modal-body stack"><p><b>Quando:</b> ${esc(when)}</p>${e.location?`<p><b>Local:</b> ${esc(e.location)}</p>`:""}${e.description?`<p>${esc(e.description)}</p>`:""}<p class="dim">${e.source==="ics"?"Importado de arquivo .ics":`Criado por ${esc(e.creator_name||"usuário do setor")}`}</p></div><div class="modal-foot"><span></span><span class="row"><button class="btn btn-primary" data-close>Fechar</button></span></div>`});}

  async function boot(){UI.mountShell();$("#prevBtn").innerHTML=icon("chevronLeft");$("#nextBtn").innerHTML=icon("chevronRight");$("#newEventBtn").innerHTML=icon("plus")+" Novo compromisso";$("#prevBtn").onclick=()=>{state.cursor=somarMeses(state.cursor,-1);load()};$("#nextBtn").onclick=()=>{state.cursor=somarMeses(state.cursor,1);load()};$("#todayBtn").onclick=()=>{state.cursor=mesDe(new Date());load()};$("#newEventBtn").onclick=()=>openEvent();addEventListener("updown:agenda-imported",load);try{await NOC.loadAccess();NOC.applyActions();await load()}catch(err){toast("Não foi possível carregar a agenda",{text:err.message,type:"danger",timeout:8000})}}
  boot();
})();
