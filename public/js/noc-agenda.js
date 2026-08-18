(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;
  const state = { cursor: new Date(), data: null, visible: new Set(), events: [] };
  state.cursor.setDate(1); state.cursor.setHours(12,0,0,0);

  const iso = (date) => date.toISOString();
  const monthRange = () => {
    const start = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
    const end = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1);
    return { start: iso(start), end: iso(end) };
  };
  const localInput = (value) => {
    const d = value ? new Date(value) : new Date(Date.now() + 3600000);
    const pad = n => String(n).padStart(2,"0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const ownerKey = e => e.owner_type === "sector" ? `sector:${e.sector_id}` : "user";
  const colorOf = e => e.sector_color || "#06b6d4";
  const filtered = () => state.events.filter(e => state.visible.has(ownerKey(e)));

  function checkLocalAlerts() {
    const now = Date.now();
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem("updown.agenda.alerts") || "{}"); } catch { /* indisponível */ }
    for (const event of state.events) {
      if (!event.alert_popup) continue;
      const diff = new Date(event.start).getTime() - now;
      if (diff < 0 || diff > event.alert_minutes * 60000) continue;
      const key = `${event.id}:${event.start}`;
      if (seen[key]) continue;
      seen[key] = now;
      toast(`Agenda: ${event.title}`, { text: `${event.sector_name || "Minha agenda"} · começa em breve`, type: "info", timeout: 10000 });
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(event.title, { body: `${event.sector_name || "Minha agenda"} · ${new Date(event.start).toLocaleString("pt-BR")}`, tag: `updown-agenda-${event.id}` });
      }
    }
    try {
      const recent = Object.fromEntries(Object.entries(seen).filter(([,when]) => now - Number(when) < 7 * 86400000));
      localStorage.setItem("updown.agenda.alerts", JSON.stringify(recent));
    } catch { /* indisponível */ }
  }

  async function load() {
    const range = monthRange();
    state.data = await NOC.api(`/api/agenda?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`);
    state.events = state.data.events || [];
    if (!state.visible.size) {
      state.visible.add("user");
      (state.data.sectors || []).forEach(s => state.visible.add(`sector:${s.id}`));
    }
    render();
    checkLocalAlerts();
  }

  function renderFilters() {
    const calendars = [{ key:"user", name:"Minha agenda", color:"#06b6d4" },
      ...(state.data.sectors || []).map(s => ({ key:`sector:${s.id}`, name:s.name, color:s.color }))];
    $("#calendarFilters").innerHTML = calendars.map(c => `<label class="chip" style="--event-color:${esc(c.color)}">
      <input type="checkbox" data-calendar-filter="${c.key}" ${state.visible.has(c.key)?"checked":""}>
      <i class="dot" style="background:${esc(c.color)}"></i>${esc(c.name)}</label>`).join("");
    $$('[data-calendar-filter]').forEach(input => input.onchange = () => {
      if (input.checked) state.visible.add(input.dataset.calendarFilter); else state.visible.delete(input.dataset.calendarFilter);
      renderCalendar(); renderUpcoming();
    });
    const google = state.data.google || {};
    $("#googleState").innerHTML = google.connected
      ? `<span class="badge badge-ok">${icon("check")} Google vinculado</span> ${esc(google.email || "")}`
      : `<span class="badge">Google não vinculado</span> <button class="btn btn-sm" data-link-google type="button">Vincular</button>`;
    $("[data-link-google]")?.addEventListener("click", () => location.href=`/api/calendar/google/start?return_to=${encodeURIComponent(location.pathname)}`);
  }

  function renderCalendar() {
    const title = state.cursor.toLocaleDateString("pt-BR",{month:"long",year:"numeric"});
    $("#monthTitle").textContent = title.charAt(0).toUpperCase()+title.slice(1);
    const events = filtered();
    $("#eventCount").textContent = `${events.length} compromisso${events.length===1?"":"s"}`;
    const first = new Date(state.cursor.getFullYear(),state.cursor.getMonth(),1);
    const gridStart = new Date(first); gridStart.setDate(1-first.getDay());
    const today = new Date();
    $("#calendarGrid").innerHTML = Array.from({length:42},(_,i) => {
      const day = new Date(gridStart); day.setDate(gridStart.getDate()+i);
      const next = new Date(day); next.setDate(day.getDate()+1);
      const list = events.filter(e => new Date(e.start)<next && new Date(e.end)>day).slice(0,4);
      const sameMonth = day.getMonth()===state.cursor.getMonth();
      const isToday = day.toDateString()===today.toDateString();
      return `<div class="calendar-day ${sameMonth?"":"is-outside"} ${isToday?"is-today":""}" data-day="${day.toISOString()}">
        <span class="day-number">${day.getDate()}</span>
        ${list.map(e=>`<button class="day-event" style="--event-color:${esc(colorOf(e))}" data-event="${e.id}" title="${esc(e.title)}">
          ${e.all_day?"":new Date(e.start).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})+" · "}${esc(e.title)}</button>`).join("")}
        ${events.filter(e=>new Date(e.start)<next&&new Date(e.end)>day).length>4?'<small class="dim">mais compromissos…</small>':""}
      </div>`;
    }).join("");
    $$('[data-event]').forEach(b=>b.onclick=e=>{e.stopPropagation();openEvent(state.events.find(x=>x.id===+b.dataset.event));});
    $$('[data-day]').forEach(day=>day.onclick=()=>openEvent(null,new Date(day.dataset.day)));
  }

  function renderUpcoming() {
    const list=filtered().filter(e=>new Date(e.end)>=new Date()).slice(0,20);
    $("#upcomingList").innerHTML=list.length?list.map(e=>{
      const d=new Date(e.start);
      return `<button class="upcoming-item" style="--event-color:${esc(colorOf(e))}" data-upcoming="${e.id}" type="button">
        <span class="upcoming-date"><b>${d.getDate()}</b><small>${d.toLocaleDateString("pt-BR",{month:"short"}).replace(".","")}</small></span>
        <span style="text-align:left"><b>${esc(e.title)}</b><br><small class="dim">${e.all_day?"Dia todo":d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}${e.location?" · "+esc(e.location):""}</small><br>
        <span class="calendar-owner" style="--event-color:${esc(colorOf(e))}"><i></i>${esc(e.sector_name||"Minha agenda")}</span></span>
      </button>`;
    }).join(""):`<div class="empty"><span class="empty-icon">${icon("calendar")}</span><b>Nenhum compromisso próximo</b><p>Use “Novo compromisso” para começar.</p></div>`;
    $$('[data-upcoming]').forEach(b=>b.onclick=()=>openEvent(state.events.find(e=>e.id===+b.dataset.upcoming)));
  }

  function render(){renderFilters();renderCalendar();renderUpcoming();}

  function openEvent(event=null,day=null){
    if(event&&!event.can_edit)return openDetails(event);
    const start=event?new Date(event.start):(day||new Date());
    if(!event){start.setHours(new Date().getHours()+1,0,0,0)}
    const end=event?new Date(event.end):new Date(start.getTime()+3600000);
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
        <div class="agenda-alerts"><b>${icon("bell")} Alertas</b><label><input type="checkbox" id="alertEmail" ${event?.alert_email!==false?"checked":""}> E-mail</label><label><input type="checkbox" id="alertPopup" ${event?.alert_popup!==false?"checked":""}> Popup</label><label class="row" style="gap:6px"><input class="input" style="width:80px" id="alertMinutes" type="number" min="0" max="1440" value="${event?.alert_minutes??10}"> min antes</label></div>
        <span class="field-error" id="eventError" hidden></span>
      </div>
      <div class="modal-foot"><span>${event?.sync_error?`<small class="dim">${icon("alert")} ${esc(event.sync_error)}</small>`:""}</span><span class="row">${event?.can_delete?'<button class="btn btn-danger" data-delete type="button">Excluir</button>':""}<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Salvar</button></span></div>`,
      onMount:(host,close)=>{
        $("[data-save]",host).onclick=async()=>{
          const owner=$("#eventOwner",host).value.split(":"), startValue=new Date($("#eventStart",host).value), endValue=new Date($("#eventEnd",host).value);
          const error=$("#eventError",host); if(!$("#eventTitle",host).value.trim()||!Number.isFinite(startValue.getTime())||!Number.isFinite(endValue.getTime())||endValue<=startValue){error.hidden=false;error.textContent="Informe título e um término posterior ao início.";return}
          const payload={title:$("#eventTitle",host).value.trim(),owner_type:owner[0],sector_id:owner[1]?Number(owner[1]):null,location:$("#eventLocation",host).value.trim(),description:$("#eventDescription",host).value.trim(),start:startValue.toISOString(),end:endValue.toISOString(),all_day:$("#eventAllDay",host).checked,alert_email:$("#alertEmail",host).checked,alert_popup:$("#alertPopup",host).checked,alert_minutes:Number($("#alertMinutes",host).value)};
          if(payload.alert_popup&&"Notification" in window&&Notification.permission==="default")await Notification.requestPermission();
          try{await NOC.api(event?`/api/agenda/events/${event.id}`:"/api/agenda/events",{method:event?"PATCH":"POST",body:JSON.stringify(payload)});close();await load();toast(event?"Compromisso atualizado":"Compromisso criado",{text:"Alertas e sincronização foram configurados.",type:"ok"});}
          catch(err){error.hidden=false;error.textContent=err.message}
        };
        $("[data-delete]",host)?.addEventListener("click",()=>askConfirm({title:"Excluir compromisso?",text:"Ele também será removido do Google Agenda quando estiver sincronizado.",confirmLabel:"Excluir",danger:true,onConfirm:async()=>{try{await NOC.api(`/api/agenda/events/${event.id}`,{method:"DELETE"});close();await load();toast("Compromisso excluído",{type:"ok"})}catch(err){toast("Não foi possível excluir",{text:err.message,type:"danger"})}}}));
      }
    });
  }

  function openDetails(e){modal({labelledBy:"eventDetailsTitle",html:`<div class="modal-head"><div><span class="kicker">${esc(e.sector_name||"Agenda pessoal")}</span><h2 id="eventDetailsTitle">${esc(e.title)}</h2></div><button class="btn btn-ghost btn-icon" data-close>${icon("close")}</button></div><div class="modal-body stack"><p><b>Quando:</b> ${new Date(e.start).toLocaleString("pt-BR")} até ${new Date(e.end).toLocaleString("pt-BR")}</p>${e.location?`<p><b>Local:</b> ${esc(e.location)}</p>`:""}${e.description?`<p>${esc(e.description)}</p>`:""}<p class="dim">Criado por ${esc(e.creator_name||"usuário do setor")}</p></div><div class="modal-foot"><span></span><span class="row">${e.html_link?'<a class="btn" target="_blank" rel="noopener" href="'+esc(e.html_link)+'">Abrir no Google</a>':""}<button class="btn btn-primary" data-close>Fechar</button></span></div>`});}

  async function boot(){UI.mountShell();$("#prevBtn").innerHTML=icon("chevronLeft");$("#nextBtn").innerHTML=icon("chevronRight");$("#newEventBtn").innerHTML=icon("plus")+" Novo compromisso";$("#prevBtn").onclick=()=>{state.cursor.setMonth(state.cursor.getMonth()-1);load()};$("#nextBtn").onclick=()=>{state.cursor.setMonth(state.cursor.getMonth()+1);load()};$("#todayBtn").onclick=()=>{state.cursor=new Date();state.cursor.setDate(1);load()};$("#newEventBtn").onclick=()=>openEvent();try{await NOC.loadAccess();NOC.applyActions();await load()}catch(err){toast("Não foi possível carregar a agenda",{text:err.message,type:"danger",timeout:8000})}}
  boot();
  setInterval(checkLocalAlerts, 30000);
})();
