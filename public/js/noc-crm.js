(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;
  const state = { data:null, sector:"", search:"", status:"open", owner:"" };
  const priorities = { low:"Baixa",normal:"Normal",high:"Alta",urgent:"Urgente" };
  const kinds = { note:"Nota",call:"Ligação",whatsapp:"WhatsApp",email:"E-mail",meeting:"Reunião",status:"Mudança de etapa",system:"Sistema" };
  const money = value => Number(value||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
  /* O próximo contato é combinado com o cliente em horário de Brasília: é
     nesse fuso que ele aparece na tela, que o campo é preenchido e que a hora
     digitada vira UTC para o banco (TEMPO.deInput). */
  const dateTime = value => TEMPO.fmt(value,{dateStyle:"short",timeStyle:"short"},"Não agendado");
  const localInput = value => TEMPO.paraInput(value);
  const stagesOf = sectorId => (state.data?.stages||[]).filter(x=>String(x.sector_id)===String(sectorId));
  const usersOf = sectorId => (state.data?.users||[]).filter(x=>String(x.sector_id)===String(sectorId));
  const sectorOf = id => (state.data?.sectors||[]).find(x=>String(x.id)===String(id));
  // Carimbo ilegível não vira atraso: sem data confiável, o cartão fica neutro.
  const overdue = item => { const d = item.is_closed?null:TEMPO.instante(item.next_contact_at); return Boolean(d)&&d<new Date(); };

  async function load(preferredCaseId=null){
    const content=$("#crmContent"); NOC.skeleton(content,5);
    try{
      state.data=await NOC.api("/api/crm");
      if(!state.sector && state.data.sectors?.length) state.sector=String((state.data.sectors.find(s=>s.code==="comercial")||state.data.sectors[0]).id);
      if(state.sector!=="all"&&!sectorOf(state.sector))state.sector=state.data.sectors?.length?String(state.data.sectors[0].id):"";
      render(); if(preferredCaseId)await openDetails(preferredCaseId);
    }catch(err){NOC.errorState(content,err,()=>load());}
  }

  function filteredCases(){
    const term=state.search.trim().toLocaleLowerCase("pt-BR");
    return (state.data?.cases||[]).filter(item=>{
      if(state.sector!=="all"&&String(item.sector_id)!==state.sector)return false;
      if(state.status==="open"&&item.is_closed)return false;
      if(state.status==="closed"&&!item.is_closed)return false;
      if(state.owner==="none"&&item.assigned_user_id!=null)return false;
      if(state.owner&&state.owner!=="none"&&String(item.assigned_user_id||"")!==state.owner)return false;
      if(term&&!`${item.title} ${item.customer_name} ${item.customer_document} ${item.phone} ${item.email} ${item.city} ${item.tags}`.toLocaleLowerCase("pt-BR").includes(term))return false;
      return true;
    });
  }

  function renderKpis(){
    const visible=(state.data?.cases||[]).filter(x=>state.sector==="all"||String(x.sector_id)===state.sector);
    const open=visible.filter(x=>!x.is_closed);
    // "Para hoje" é o dia de Brasília, não o do computador de quem abriu a tela.
    const dueToday=open.filter(x=>x.next_contact_at&&TEMPO.hoje(x.next_contact_at)).length;
    const value=open.reduce((sum,x)=>sum+Number(x.estimated_value||0),0);
    $("#crmKpis").innerHTML=[
      ["users",open.length,"Em aberto"],["alert",open.filter(overdue).length,"Contatos atrasados"],
      ["calendar",dueToday,"Contatos para hoje"],["finance",money(value),"Valor em andamento"]
    ].map(([ico,n,label])=>`<article class="card crm-kpi"><span class="crm-kpi-icon">${icon(ico)}</span><div><strong>${esc(n)}</strong><span>${label}</span></div></article>`).join("");
  }

  function renderSectorTabs(){
    const sectors=state.data?.sectors||[];
    $("#sectorTabs").innerHTML=`<button class="crm-sector-tab" style="--sector:#64748b" data-sector="all" aria-pressed="${state.sector==="all"}"><i></i>Todos os setores</button>`+
      sectors.map(s=>`<button class="crm-sector-tab" style="--sector:${esc(s.color)}" data-sector="${s.id}" aria-pressed="${state.sector===String(s.id)}"><i></i>${esc(s.name)}</button>`).join("");
    $$('[data-sector]').forEach(button=>button.onclick=()=>{state.sector=button.dataset.sector;state.owner="";render()});
  }

  function renderOwnerFilter(){
    const users=state.sector==="all"?(state.data?.users||[]):usersOf(state.sector);
    const unique=[...new Map(users.map(u=>[u.id,u])).values()];
    $("#ownerFilter").innerHTML='<option value="">Todos os responsáveis</option><option value="none">Sem responsável</option>'+unique.map(u=>`<option value="${u.id}" ${state.owner===String(u.id)?"selected":""}>${esc(u.display_name)}</option>`).join("");
    if(state.owner==="none")$("#ownerFilter").value="none";
  }

  function caseCard(item){
    return `<button class="crm-card" type="button" data-case="${item.id}">
      <span class="crm-card-top"><span class="crm-priority ${esc(item.priority)}">${esc(priorities[item.priority]||item.priority)}</span>${item.estimated_value?`<b>${esc(money(item.estimated_value))}</b>`:""}</span>
      <h3>${esc(item.title)}</h3><p class="crm-card-customer">${esc(item.customer_name)}</p>
      <span class="crm-card-meta"><span>${esc(item.assigned_name||"Sem responsável")}</span><span class="crm-due ${overdue(item)?"is-overdue":""}">${item.next_contact_at?icon("clock")+esc(dateTime(item.next_contact_at)):"Sem retorno"}</span></span>
    </button>`;
  }

  function bindCards(){ $$('[data-case]').forEach(card=>card.onclick=()=>openDetails(Number(card.dataset.case))); }

  function renderContent(){
    const cases=filteredCases(),host=$("#crmContent");
    if(!(state.data?.sectors||[]).length){host.innerHTML=`<div class="card empty"><span class="empty-icon">${icon("users")}</span><b>Nenhum setor disponível</b><p>Vincule seu usuário a um setor em Gerenciar plataforma para começar.</p></div>`;return}
    if(state.sector==="all"){
      const groups=(state.data.sectors||[]).map(sector=>({sector,items:cases.filter(x=>String(x.sector_id)===String(sector.id))})).filter(x=>x.items.length);
      host.innerHTML=groups.length?`<div class="crm-sector-groups">${groups.map(({sector,items})=>`<section class="card crm-sector-group"><div class="card-head"><div><h2>${esc(sector.name)}</h2><p>${items.length} registro(s) neste filtro</p></div><span class="badge" style="border-color:${esc(sector.color)}">${items.length}</span></div><div class="card-body">${items.map(caseCard).join("")}</div></section>`).join("")}</div>`:empty();
    }else{
      const stages=stagesOf(state.sector);
      host.innerHTML=cases.length||stages.length?`<div class="crm-board">${stages.map(stage=>{const items=cases.filter(x=>String(x.stage_id)===String(stage.id));return `<section class="crm-column"><div class="crm-column-head" style="--stage:${esc(stage.color)}"><h2>${esc(stage.name)}</h2><span class="badge">${items.length}</span></div><div class="crm-column-body">${items.length?items.map(caseCard).join(""):'<p class="crm-empty-column">Nenhum registro nesta etapa</p>'}</div></section>`}).join("")}</div>`:empty();
    }
    bindCards();
  }
  const empty=()=>`<div class="card empty"><span class="empty-icon">${icon("filter")}</span><b>Nenhum registro encontrado</b><p>Ajuste os filtros ou cadastre um novo item no CRM.</p></div>`;
  function render(){renderSectorTabs();renderOwnerFilter();renderKpis();renderContent();if(state.data?.can)$("#newCaseBtn").disabled=!state.data.can.create;}

  function caseForm(item=null){
    const initialSector=String(item?.sector_id||((state.sector!=="all"&&state.sector)||state.data.sectors?.[0]?.id||""));
    modal({wide:true,labelledBy:"crmFormTitle",html:`
      <div class="modal-head"><div><span class="kicker">${item?"Atualizar registro":"Novo registro"}</span><h2 id="crmFormTitle">${item?esc(item.title):"Cadastrar no CRM"}</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
      <div class="modal-body">
        <!-- Três blocos em vez de quinze campos corridos: o que é o pedido e com quem fica, quem é o cliente, e como anda a negociação. -->
        <div class="form-section">
          <div class="form-section-head"><b>Atendimento</b><span>O pedido e quem cuida dele.</span></div>
          <div class="form-grid">
            <div class="field"><label for="caseTitle">Assunto</label><input class="input" id="caseTitle" maxlength="300" value="${esc(item?.title||"")}" placeholder="Ex.: Proposta de internet empresarial" autofocus></div>
            <div class="field span-3"><label for="caseSector">Setor</label><select class="select" id="caseSector">${state.data.sectors.map(s=>`<option value="${s.id}" ${String(s.id)===initialSector?"selected":""}>${esc(s.name)}</option>`).join("")}</select></div>
            <div class="field span-3"><label for="caseStage">Etapa</label><select class="select" id="caseStage"></select></div>
            <div class="field span-3"><label for="caseOwner">Responsável</label><select class="select" id="caseOwner"></select></div>
            <div class="field span-3"><label for="casePriority">Prioridade</label><select class="select" id="casePriority">${Object.entries(priorities).map(([v,l])=>`<option value="${v}" ${v===(item?.priority||"normal")?"selected":""}>${l}</option>`).join("")}</select></div>
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-head"><b>Cliente ou prospect</b><span>Contato de quem fez o pedido.</span></div>
          <div class="form-grid">
            <div class="field span-8"><label for="customerName">Nome</label><input class="input" id="customerName" maxlength="300" value="${esc(item?.customer_name||"")}"></div>
            <div class="field span-4"><label for="customerDocument">CPF/CNPJ</label><input class="input mono" id="customerDocument" maxlength="40" inputmode="numeric" value="${esc(item?.customer_document||"")}"></div>
            <div class="field span-4"><label for="casePhone">Telefone / WhatsApp</label><input class="input" id="casePhone" type="tel" maxlength="60" value="${esc(item?.phone||"")}"></div>
            <div class="field span-4"><label for="caseEmail">E-mail</label><input class="input" id="caseEmail" type="email" maxlength="320" value="${esc(item?.email||"")}"></div>
            <div class="field span-4"><label for="caseCity">Cidade</label><input class="input" id="caseCity" maxlength="160" value="${esc(item?.city||"")}"></div>
            <div class="field"><label for="caseAddress">Endereço</label><input class="input" id="caseAddress" maxlength="500" value="${esc(item?.address||"")}"></div>
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-head"><b>Negociação</b><span>Origem, valor e o próximo passo combinado.</span></div>
          <div class="form-grid">
            <div class="field span-4"><label for="caseSource">Origem</label><input class="input" id="caseSource" maxlength="160" value="${esc(item?.source||"")}" placeholder="Indicação, site, ligação…"></div>
            <div class="field span-4"><label for="caseValue">Valor estimado (R$)</label><input class="input mono" id="caseValue" type="number" min="0" step="0.01" value="${Number(item?.estimated_value||0)}"></div>
            <div class="field span-4"><label for="caseNext">Próximo contato</label><input class="input" id="caseNext" type="datetime-local" value="${localInput(item?.next_contact_at)}"></div>
            <div class="field"><label for="caseTags">Marcadores</label><input class="input" id="caseTags" maxlength="500" value="${esc(item?.tags||"")}" placeholder="fibra, empresarial, urgente"></div>
            <div class="field"><label for="caseDetails">Detalhes</label><textarea class="textarea" id="caseDetails" rows="4">${esc(item?.details||"")}</textarea></div>
          </div>
        </div>
        <span class="field-error" id="caseError" hidden style="margin-top:var(--s-4)"></span>
      </div>
      <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Salvar</button></span></div>`,
      onMount:(host,close)=>{
        const sector=$("#caseSector",host),stage=$("#caseStage",host),owner=$("#caseOwner",host);
        const choices=()=>{const sid=sector.value;stage.innerHTML=stagesOf(sid).map(s=>`<option value="${s.id}" ${String(s.id)===String(item?.stage_id)?"selected":""}>${esc(s.name)}</option>`).join("");owner.innerHTML='<option value="">Sem responsável</option>'+usersOf(sid).map(u=>`<option value="${u.id}" ${String(u.id)===String(item?.assigned_user_id)?"selected":""}>${esc(u.display_name)}</option>`).join("")};
        choices();sector.onchange=choices;
        $("[data-save]",host).onclick=async()=>{const error=$("#caseError",host),next=$("#caseNext",host).value;const payload={
          title:$("#caseTitle",host).value.trim(),customer_name:$("#customerName",host).value.trim(),customer_document:$("#customerDocument",host).value.trim(),sector_id:Number(sector.value),stage_id:Number(stage.value),assigned_user_id:owner.value?Number(owner.value):null,priority:$("#casePriority",host).value,phone:$("#casePhone",host).value.trim(),email:$("#caseEmail",host).value.trim(),city:$("#caseCity",host).value.trim(),address:$("#caseAddress",host).value.trim(),source:$("#caseSource",host).value.trim(),estimated_value:Number($("#caseValue",host).value||0),next_contact_at:next?TEMPO.deInput(next)?.toISOString()??null:null,tags:$("#caseTags",host).value,details:$("#caseDetails",host).value.trim()};
          if(!payload.title||!payload.customer_name||!payload.stage_id){error.hidden=false;error.textContent="Informe o assunto, o cliente e a etapa.";return}
          try{const saved=await NOC.api(item?`/api/crm/cases/${item.id}`:"/api/crm/cases",{method:item?"PATCH":"POST",body:JSON.stringify(payload)});close();state.sector=String(saved.sector_id);await load();toast(item?"Registro atualizado":"Registro criado",{type:"ok"})}catch(err){error.hidden=false;error.textContent=err.message}
        };
      }});
  }

  async function openDetails(id){
    let detail;try{detail=await NOC.api(`/api/crm/cases/${id}`)}catch(err){toast("Não foi possível abrir o registro",{text:err.message,type:"danger"});return}
    const item=detail.case,activities=detail.activities||[],stages=stagesOf(item.sector_id);
    modal({wide:true,labelledBy:"crmDetailTitle",html:`
      <div class="modal-head"><div><span class="kicker">${esc(item.sector_name)} · #${item.id}</span><h2 id="crmDetailTitle">${esc(item.title)}</h2><p class="dim">${esc(item.customer_name)}</p></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
      <div class="modal-body crm-modal-layout"><div class="stack">
        <div class="row wrap"><span class="badge" style="border-color:${esc(item.stage_color)}">${esc(item.stage_name)}</span><span class="crm-priority ${esc(item.priority)}">Prioridade ${esc(priorities[item.priority])}</span>${item.tags?item.tags.split(",").map(t=>`<span class="badge">${esc(t.trim())}</span>`).join(""):""}</div>
        <div class="crm-detail-grid">
          <div class="crm-detail-item"><small>Responsável</small><b>${esc(item.assigned_name||"Sem responsável")}</b></div><div class="crm-detail-item"><small>Próximo contato</small><b class="${overdue(item)?"crm-due is-overdue":""}">${esc(dateTime(item.next_contact_at))}</b></div><div class="crm-detail-item"><small>Valor estimado</small><b>${esc(money(item.estimated_value))}</b></div>
          <div class="crm-detail-item"><small>Telefone</small><b>${esc(item.phone||"Não informado")}</b></div><div class="crm-detail-item"><small>E-mail</small><b>${esc(item.email||"Não informado")}</b></div><div class="crm-detail-item"><small>CPF/CNPJ</small><b>${esc(item.customer_document||"Não informado")}</b></div>
          <div class="crm-detail-item"><small>Cidade</small><b>${esc(item.city||"Não informada")}</b></div><div class="crm-detail-item"><small>Origem</small><b>${esc(item.source||"Não informada")}</b></div><div class="crm-detail-item"><small>Criado por</small><b>${esc(item.creator_name)}</b></div>
        </div>${item.address?`<div><small class="dim">Endereço</small><p>${esc(item.address)}</p></div>`:""}${item.details?`<div><small class="dim">Detalhes</small><p style="white-space:pre-wrap">${esc(item.details)}</p></div>`:""}
        ${state.data.can.edit?`<div class="field"><label for="quickStage">Mover para outra etapa</label><select class="select" id="quickStage">${stages.map(s=>`<option value="${s.id}" ${Number(s.id)===Number(item.stage_id)?"selected":""}>${esc(s.name)}</option>`).join("")}</select></div>`:""}
      </div><aside class="stack"><div><h3>Histórico</h3><p class="dim">Contatos e mudanças deste registro.</p></div>
        ${state.data.can.interact?`<div class="field"><label for="activityKind">Registrar interação</label><div class="row"><select class="select" id="activityKind"><option value="note">Nota</option><option value="call">Ligação</option><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option><option value="meeting">Reunião</option></select></div><textarea class="textarea" id="activityBody" rows="3" placeholder="Descreva o contato realizado ou a próxima ação"></textarea><button class="btn" data-add-activity type="button">${icon("plus")} Adicionar ao histórico</button></div>`:""}
        <div class="crm-timeline">${activities.length?activities.map(a=>`<article class="crm-activity"><small>${esc(kinds[a.kind]||a.kind)} · ${esc(a.user_name)} · ${esc(dateTime(a.created_at))}</small><p>${esc(a.body)}</p></article>`).join(""):'<p class="dim">Nenhuma interação registrada.</p>'}</div>
      </aside></div>
      <div class="modal-foot"><span>${state.data.can.delete?'<button class="btn btn-danger" data-delete type="button">Excluir</button>':""}</span><span class="row">${state.data.can.edit?'<button class="btn" data-edit type="button">Editar dados</button>':""}<button class="btn btn-primary" data-close type="button">Fechar</button></span></div>`,
      onMount:(host,close)=>{
        $("[data-edit]",host)?.addEventListener("click",()=>{close();caseForm(item)});
        $("#quickStage",host)?.addEventListener("change",async event=>{try{await NOC.api(`/api/crm/cases/${id}`,{method:"PATCH",body:JSON.stringify({stage_id:Number(event.target.value)})});close();await load(id);toast("Etapa atualizada",{type:"ok"})}catch(err){toast("Não foi possível alterar a etapa",{text:err.message,type:"danger"})}});
        $("[data-add-activity]",host)?.addEventListener("click",async()=>{const body=$("#activityBody",host).value.trim();if(!body){toast("Descreva a interação",{type:"info"});return}try{await NOC.api(`/api/crm/cases/${id}/activities`,{method:"POST",body:JSON.stringify({kind:$("#activityKind",host).value,body})});close();await load(id);toast("Interação registrada",{type:"ok"})}catch(err){toast("Não foi possível registrar",{text:err.message,type:"danger"})}});
        $("[data-delete]",host)?.addEventListener("click",()=>askConfirm({title:"Excluir este registro?",text:"O registro e todo o histórico de interações serão removidos permanentemente.",confirmLabel:"Excluir",danger:true,onConfirm:async()=>{try{await NOC.api(`/api/crm/cases/${id}`,{method:"DELETE"});close();await load();toast("Registro excluído",{type:"ok"})}catch(err){toast("Não foi possível excluir",{text:err.message,type:"danger"})}}}));
      }});
  }

  async function boot(){
    UI.mountShell();$("#newCaseBtn").innerHTML=icon("plus")+" Novo registro";$("#searchIcon").innerHTML=icon("search");$("#refreshBtn").innerHTML=icon("refresh");
    $("#newCaseBtn").onclick=()=>caseForm();$("#refreshBtn").onclick=()=>load();
    $("#statusFilter").onchange=e=>{state.status=e.target.value;renderKpis();renderContent()};
    $("#ownerFilter").onchange=e=>{state.owner=e.target.value==="none"?"none":e.target.value;renderContent()};
    let timer;$("#crmSearch").oninput=e=>{clearTimeout(timer);timer=setTimeout(()=>{state.search=e.target.value;renderContent()},180)};
    try{await NOC.loadAccess();NOC.applyActions();await load()}catch(err){NOC.errorState($("#crmContent"),err,()=>boot())}
  }
  boot();
})();
