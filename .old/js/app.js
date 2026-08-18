
const state = { equipamentos: [], conexoes: [], pops: [] };
const positions = {
  f1a:{x:40,y:40}, s6730a:{x:300,y:40}, s6750a:{x:560,y:40},
  nokia1:{x:820,y:40}, datacom1:{x:820,y:210}, nokia2:{x:1080,y:40},
  datacom2:{x:1080,y:210}, s6750b:{x:1340,y:125}, s6730b:{x:1600,y:125},
  santos:{x:1860,y:20}, sv:{x:1860,y:230}, m8:{x:2120,y:125}
};
let currentDeviceId=null, currentPopId=null, detailEditMode=false, detailBackup=null;

async function loadData(){
  const cached=localStorage.getItem("updown-topologia-data");
  if(cached){
    try { Object.assign(state,JSON.parse(cached)); normalizeState(); persist(); renderAll(); return; } catch(e){ console.warn(e); }
  }
  const [a,b,c]=await Promise.all([
    fetch("data/equipamentos.json"),fetch("data/conexoes.json"),fetch("data/pops.json")
  ]);
  if(!a.ok||!b.ok||!c.ok) throw new Error("Falha ao carregar os arquivos JSON.");
  state.equipamentos=await a.json(); state.conexoes=await b.json(); state.pops=await c.json();
  normalizeState(); renderAll(); applyConfig();
}
function migratePortNumbering(){
  // Versão antiga do cadastro tinha o NE F1A começando em 0.
  // A topologia atual é 100% 1-based. Conexões já utilizam a numeração 1-based.
  state.equipamentos.forEach(e=>{
    if(!Array.isArray(e.portas)||!e.portas.length)return;
    const nums=e.portas.map(p=>Number(p.numero)).filter(Number.isFinite);
    if(nums.length && Math.min(...nums)===0){
      e.portas.forEach(p=>{ p.numero=Number(p.numero)+1; });
    }
  });
}
function normalizeState(){
  state.equipamentos=Array.isArray(state.equipamentos)?state.equipamentos:[];
  migratePortNumbering();
  state.conexoes=Array.isArray(state.conexoes)?state.conexoes:[];
  state.pops=Array.isArray(state.pops)?state.pops:[];
  state.equipamentos.forEach((e,i)=>{
    if(!e.id)e.id="eq-"+Date.now()+"-"+i;
    if(!Array.isArray(e.portas))e.portas=[];
    e.portas.forEach((p,j)=>{ if(p.numero===undefined)p.numero=j+1; if(!p.status)p.status="livre"; });
  });
  state.pops.forEach((p,i)=>{
    if(!p.id)p.id="pop-"+Date.now()+"-"+i;
    if(!Array.isArray(p.equipamentos))p.equipamentos=[];
    if(!Array.isArray(p.rotas))p.rotas=[];
  });
}
function persist(){
  localStorage.setItem("updown-topologia-data",JSON.stringify(state));
}
function renderAll(){ renderSidebar(); renderTopology(); renderPops(); }

function getDevice(id){return state.equipamentos.find(d=>d.id===id);}
function getPop(id){return state.pops.find(p=>p.id===id);}
function getPortConnection(id,port){
  const c=state.conexoes.find(x=>(x.origem===id&&+x.portaOrigem===+port)||(x.destino===id&&+x.portaDestino===+port));
  return c?{c,isOrigin:c.origem===id&&+c.portaOrigem===+port}:null;
}
function connectionFor(id,port){
  const i=getPortConnection(id,port); if(!i)return"livre";
  const c=i.c, remote=getDevice(i.isOrigin?c.destino:c.origem);
  return `${i.isOrigin?"→":"←"} ${remote?.nome|| (i.isOrigin?c.destino:c.origem)} • porta ${i.isOrigin?c.portaDestino:c.portaOrigem}`;
}
function renderSidebar(filter=""){
  const list=document.getElementById("deviceList"),q=filter.toLowerCase(); list.innerHTML="";
  state.equipamentos.filter(d=>JSON.stringify(d).toLowerCase().includes(q)).forEach(d=>{
    const item=document.createElement("div"); item.className="device-link";
    item.innerHTML=`<b>${escapeHtml(d.nome)}</b><small>${escapeHtml(d.modelo||"")}</small><span class="badge">${d.portas.length} portas</span>`;
    item.onclick=()=>openDetail(d.id); list.appendChild(item);
  });
}
function nodeCenter(id){const p=positions[id];return p?{x:p.x+105,y:p.y+58}:null;}
function renderTopology(){
  const c=document.getElementById("topology"); c.innerHTML="";
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.classList.add("topology-lines");svg.setAttribute("viewBox","0 0 2350 420");svg.setAttribute("preserveAspectRatio","none");
  state.conexoes.forEach((x,i)=>{
    const a=nodeCenter(x.origem),b=nodeCenter(x.destino);if(!a||!b)return;
    const mid=(a.x+b.x)/2,path=document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d",`M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`);path.classList.add("topo-edge");path.onclick=()=>showConnection(x);svg.appendChild(path);
    const g=document.createElementNS("http://www.w3.org/2000/svg","g");g.classList.add("edge-label");
    const r=document.createElementNS("http://www.w3.org/2000/svg","rect");r.setAttribute("x",mid-62);r.setAttribute("y",(a.y+b.y)/2-19);r.setAttribute("width",124);r.setAttribute("height",20);r.setAttribute("rx",6);
    const t=document.createElementNS("http://www.w3.org/2000/svg","text");t.setAttribute("x",mid);t.setAttribute("y",(a.y+b.y)/2-5);t.setAttribute("text-anchor","middle");t.textContent=`${x.portaOrigem} ↔ ${x.portaDestino}`;
    g.append(r,t);g.onclick=()=>showConnection(x);svg.appendChild(g);
  });
  c.appendChild(svg);
  state.equipamentos.forEach(d=>{
    const p=positions[d.id];if(!p)return;
    const n=document.createElement("article");n.className="node";n.style.left=p.x+"px";n.style.top=p.y+"px";
    n.innerHTML=`<span class="count">${d.portas.length} portas</span><div class="type">${escapeHtml(d.categoria||"Equipamento")}</div><h3>${escapeHtml(d.nome)}</h3><p>${escapeHtml(d.modelo||"")}</p>`;
    n.onclick=()=>openDetail(d.id);c.appendChild(n);
  });
}
function renderPops(){
  const grid=document.getElementById("popGrid"),details=document.getElementById("popDetails");grid.innerHTML="";details.innerHTML="";
  state.pops.forEach(p=>{
    const card=document.createElement("div");card.className="pop";
    card.innerHTML=`<b>${escapeHtml(p.nome)}</b><small>${p.equipamentos.length} equipamento(s)</small><span class="pop-click">Clique para ver</span>`;
    card.onclick=()=>openPop(p.id);grid.appendChild(card);
    const panel=document.createElement("div");panel.className="pop-detail-card";
    panel.innerHTML=`<div class="pop-detail-title"><div><b>${escapeHtml(p.nome)}</b><small>${p.rotas.map(escapeHtml).join(" • ")}</small></div><span>${p.equipamentos.length} equipamento(s)</span></div>
      <div class="pop-equip-list">${p.equipamentos.map((e,i)=>`<div class="pop-equip"><div class="pop-equip-index">${i+1}</div><div><b>${escapeHtml(e.nome)}</b><small>${escapeHtml(e.modelo||"")}</small><p>${escapeHtml(e.observacao||"")}</p></div></div>`).join("")}</div>`;
    details.appendChild(panel);
  });
}
function openPop(id){
  currentPopId=id;const p=getPop(id);if(!p)return;
  document.getElementById("popModalName").textContent=p.nome;document.getElementById("popModalRoutes").textContent=p.rotas.join(" • ");
  renderPopModalBody(p);document.getElementById("popModal").classList.remove("hidden");
}
function renderPopModalBody(p){
  const body=document.getElementById("popModalEquipments");
  body.innerHTML=`<div class="pop-edit-toolbar"><button class="primary-btn" id="addPopEquipment">+ Adicionar aparelho ao POP</button></div>
    ${p.equipamentos.length?p.equipamentos.map((e,i)=>`<div class="pop-modal-eq editable-pop-eq" data-index="${i}"><span>${i+1}</span><div><b>${escapeHtml(e.nome)}</b><small>${escapeHtml(e.modelo||"")}</small><p>${escapeHtml(e.observacao||"")}</p></div><button class="icon-edit pop-eq-edit" title="Editar aparelho do POP">✎</button></div>`).join(""):`<div class="empty-pop">Nenhum aparelho cadastrado neste POP.</div>`}`;
  document.getElementById("addPopEquipment").onclick=()=>editPopEquipment(-1);
  body.querySelectorAll(".pop-eq-edit").forEach(b=>b.onclick=()=>editPopEquipment(+b.closest(".editable-pop-eq").dataset.index));
}
function editPopEquipment(index){
  const p=getPop(currentPopId);if(!p)return;
  const old=index>=0?p.equipamentos[index]:{nome:"",modelo:"",observacao:""};
  const name=prompt("Nome do aparelho:",old.nome||"");if(name===null)return;
  const model=prompt("Modelo:",old.modelo||"");if(model===null)return;
  const obs=prompt("Observação:",old.observacao||"");if(obs===null)return;
  const item={nome:name,modelo:model,observacao:obs};
  if(index<0)p.equipamentos.push(item);else p.equipamentos[index]=item;
  persist();renderAll();renderPopModalBody(p);
}
function closePop(){document.getElementById("popModal").classList.add("hidden");}

function openDetail(id){
  currentDeviceId=id;const d=getDevice(id);if(!d)return;
  document.getElementById("detailName").textContent=d.nome;document.getElementById("detailModel").textContent=d.modelo||"";
  document.getElementById("detailType").textContent=d.categoria||"—";document.getElementById("detailLocal").textContent=d.local||"—";
  document.getElementById("detailCount").textContent=d.portas.length;document.getElementById("detailConnected").textContent=d.portas.filter(p=>getPortConnection(id,p.numero)).length;
  document.getElementById("detailNote").textContent=d.observacao||"";
  renderDetailEquipmentImage(d);
  detailEditMode=false;document.getElementById("inlineEditActions").classList.add("hidden");renderDetailRows(d);
  document.getElementById("modal").classList.remove("hidden");
}
function getEquipmentImage(d){
  if(d?.imagem) return d.imagem;
  const model=(d?.modelo||"").toLowerCase();
  if(model.includes("netengine 8000 f1a")) return "/assets/equipamentos/ne-f1a.png";
  return "";
}
function portConnectionDetails(d,p){
  const info=getPortConnection(d.id,p.numero),c=info?.c;
  if(!c) return {status:"Livre",remote:"Nenhuma conexão cadastrada"};
  const remote=info.isOrigin?getDevice(c.destino):getDevice(c.origem);
  return {
    status:"Conectada",
    remote:`${remote?.nome|| (info.isOrigin?c.destino:c.origem)} • porta ${info.isOrigin?c.portaDestino:c.portaOrigem}`
  };
}
function renderDetailEquipmentImage(d){
  const host=document.getElementById("detailEquipmentImage");
  if(!host)return;
  const ports=Array.isArray(d.portas)?d.portas:[];
  const image=d.imagem ? d.imagem.replace("ne-f1a.png","ne-f1a-front.png") : "";
  const isF1A=d.layoutPortas==="f1a" || d.id==="f1a";

  host.innerHTML=`<div class="equipment-image-stage ${isF1A?"real-front":"generic-front"}" data-device="${escapeAttr(d.id||"")}">
    <div class="equipment-3d-scene">
      <div class="equipment-3d-object">
        <div class="equipment-face equipment-face-top"></div>
        <div class="equipment-face equipment-face-left"></div>
        <div class="equipment-face equipment-face-right"></div>
        <div class="equipment-face equipment-face-bottom"></div>
        <div class="equipment-face equipment-face-back"></div>
        <div class="equipment-face equipment-face-front">
          ${image ? `<img class="equipment-real-image" src="${escapeAttr(image)}" alt="Vista frontal de ${escapeAttr(d.nome||d.modelo||"equipamento")}">`
                  : `<div class="equipment-generic-image"><div class="generic-brand">${escapeHtml(d.fabricante||"EQUIPAMENTO")}</div><div class="generic-model">${escapeHtml(d.modelo||d.nome||"")}</div></div>`}
          <div class="equipment-hotspots ${isF1A?"f1a-hotspots":"generic-hotspots"}"></div>
        </div>
      </div>
    </div>
    <div class="equipment-3d-help"><span>3D</span> Mova o mouse para inspecionar • passe sobre uma porta para ampliar</div>
    <div class="equipment-image-caption"><span>PAINEL FRONTAL</span><strong>${escapeHtml(d.nome||d.modelo||"EQUIPAMENTO")}</strong><small>${ports.filter(p=>!getPortConnection(d.id,p.numero)).length} portas vagas</small></div>
    <div class="equipment-port-tooltip hidden" id="equipmentPortTooltip"></div>
  </div>`;

  const stage=host.querySelector(".equipment-image-stage");
  const object=host.querySelector(".equipment-3d-object");
  const front=host.querySelector(".equipment-face-front");
  const hotspots=host.querySelector(".equipment-hotspots");
  const tooltip=host.querySelector("#equipmentPortTooltip");

  function hotspotPosition(port,index){
    if(isF1A){
      if(index<48) return {x:5.35+(index/47)*73.35,y:57.0,w:1.32,h:21};
      return {x:79.2+((index-48)/7)*17.0,y:57.0,w:3.0,h:21};
    }
    const total=Math.max(1,ports.length),cols=Math.min(total,16),row=Math.floor(index/cols),col=index%cols,rows=Math.ceil(total/cols);
    return {x:8+(col/Math.max(1,cols-1))*84,y:42+(row/Math.max(1,rows-1))*20,w:Math.min(84/cols*1.5,6),h:14};
  }

  function connectionText(port){
    const c=getPortConnection(d.id,port.numero);
    if(!c)return {status:"Livre",remote:"Nenhuma conexão cadastrada"};
    const remoteId=c.isOrigin?c.c.destino:c.c.origem,remote=getDevice(remoteId);
    const remotePort=c.isOrigin?c.c.portaDestino:c.c.portaOrigem;
    return {status:"Conectada",remote:`${remote?.nome||remoteId} • porta ${remotePort}`};
  }

  function showPort(btn,port){
    const info=connectionText(port);
    tooltip.innerHTML=`<div class="tooltip-kicker">INTERFACE FÍSICA</div><strong>PORTA ${escapeHtml(String(port.numero))}</strong>
      <span class="tooltip-status ${portVisualState(d,port)}">${escapeHtml(info.status)}</span>
      <dl><dt>Capacidade</dt><dd>${escapeHtml(port.capacidade||"Não informada")}</dd>
      <dt>Tipo</dt><dd>${escapeHtml(port.tipo||"Não informado")}</dd>
      <dt>Conexão</dt><dd>${escapeHtml(info.remote)}</dd></dl>`;
    tooltip.classList.remove("hidden");
    const br=btn.getBoundingClientRect(),sr=stage.getBoundingClientRect();
    let left=br.right-sr.left+14,top=br.top-sr.top+(br.height/2)-65;
    if(left+250>sr.width)left=br.left-sr.left-264;
    top=Math.max(10,Math.min(top,sr.height-145));
    tooltip.style.left=`${left}px`;tooltip.style.top=`${top}px`;
    hotspots.querySelectorAll(".active").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");front.classList.add("port-zooming");
  }
  function hidePort(btn){
    btn.classList.remove("active");
    setTimeout(()=>{if(!hotspots.querySelector(".active")){tooltip.classList.add("hidden");front.classList.remove("port-zooming")}},100);
  }

  ports.forEach((port,index)=>{
    const pos=hotspotPosition(port,index),btn=document.createElement("button");
    btn.type="button";btn.className=`equipment-port-hotspot ${portVisualState(d,port)}`;
    btn.dataset.port=port.numero;btn.style.left=`${pos.x}%`;btn.style.top=`${pos.y}%`;btn.style.width=`${pos.w}%`;btn.style.height=`${pos.h}%`;
    btn.innerHTML=`<span>${escapeHtml(String(port.numero))}</span>`;btn.title=`Porta ${port.numero} • ${port.capacidade||"capacidade não informada"}`;
    hotspots.appendChild(btn);
    btn.addEventListener("mouseenter",()=>showPort(btn,port));btn.addEventListener("focus",()=>showPort(btn,port));
    btn.addEventListener("mouseleave",()=>hidePort(btn));btn.addEventListener("blur",()=>hidePort(btn));
    btn.addEventListener("click",()=>{
      showPort(btn,port);
      const row=[...document.querySelectorAll("#detailRows tr")].find(tr=>+tr.dataset.port===+port.numero);
      row?.scrollIntoView({behavior:"smooth",block:"center"});row?.classList.add("port-row-highlight");
      setTimeout(()=>row?.classList.remove("port-row-highlight"),1400);
    });
  });

  stage.addEventListener("mousemove",e=>{
    const r=stage.getBoundingClientRect(),px=(e.clientX-r.left)/r.width-.5,py=(e.clientY-r.top)/r.height-.5;
    object.style.setProperty("--rx",`${-py*7}deg`);object.style.setProperty("--ry",`${px*11}deg`);
  });
  stage.addEventListener("mouseleave",()=>{object.style.setProperty("--rx","0deg");object.style.setProperty("--ry","0deg")});
}

function renderDetailRows(d){
  const tbody=document.getElementById("detailRows");tbody.innerHTML="";
  d.portas.forEach(p=>{
    const i=getPortConnection(d.id,p.numero),c=i?.c,remote=c?(i.isOrigin?getDevice(c.destino):getDevice(c.origem)):null;
    const tr=document.createElement("tr");tr.dataset.port=p.numero;if(c)tr.className="connected";
    tr.innerHTML=`<td><strong>${p.numero}</strong></td><td>${escapeHtml(p.capacidade||"")}</td><td>${escapeHtml(p.tipo||"")}</td><td>${escapeHtml(p.status||"livre")}</td><td>${c?escapeHtml((remote?.nome|| (i.isOrigin?c.destino:c.origem))+" • porta "+(i.isOrigin?c.portaDestino:c.portaOrigem)):"Livre"}</td>`;
    tbody.appendChild(tr);
  });
}
function enterInlineEdit(){
  const d=getDevice(currentDeviceId);if(!d)return;detailEditMode=true;
  detailBackup=JSON.parse(JSON.stringify({equipamento:d,conexoes:state.conexoes}));
  const tbody=document.getElementById("detailRows");
  tbody.innerHTML=d.portas.map(p=>{
    const i=getPortConnection(d.id,p.numero),c=i?.c,remoteId=c?(i.isOrigin?c.destino:c.origem):"",remotePort=c?(i.isOrigin?c.portaDestino:c.portaOrigem):"";
    return `<tr class="inline-edit-row" data-port="${p.numero}"><td><strong>${p.numero}</strong></td>
      <td><input class="inline-port-capacity" value="${escapeAttr(c?.capacidade||p.capacidade||"")}" placeholder="100 Gbps"></td>
      <td><input class="inline-port-type" value="${escapeAttr(c?.tipo||p.tipo||"")}" placeholder="BGP/MPLS"></td>
      <td><select class="inline-port-status"><option value="livre" ${p.status==="livre"&&!c?"selected":""}>Livre</option><option value="conectada" ${c||p.status==="conectada"?"selected":""}>Conectada</option><option value="reservada" ${p.status==="reservada"?"selected":""}>Reservada</option><option value="manutencao" ${p.status==="manutencao"?"selected":""}>Manutenção</option></select></td>
      <td><div class="inline-connection-fields"><input class="inline-port-remote" value="${escapeAttr(remoteId)}" placeholder="Equipamento / string"><input class="inline-port-remote-port" value="${escapeAttr(remotePort)}" placeholder="Porta"></div></td></tr>`;
  }).join("");
  document.getElementById("inlineEditActions").classList.remove("hidden");document.getElementById("inlineEditStatus").textContent="Edite diretamente os campos das portas.";
}
function saveInlineEdit(){
  const d=getDevice(currentDeviceId);if(!d)return;
  document.querySelectorAll("#detailRows .inline-edit-row").forEach(tr=>{
    const num=+tr.dataset.port,p=d.portas.find(x=>+x.numero===num);if(!p)return;
    const cap=tr.querySelector(".inline-port-capacity").value.trim(),type=tr.querySelector(".inline-port-type").value.trim(),status=tr.querySelector(".inline-port-status").value,remote=tr.querySelector(".inline-port-remote").value.trim(),rport=tr.querySelector(".inline-port-remote-port").value.trim();
    p.capacidade=cap;p.tipo=type;p.status=status;
    state.conexoes=state.conexoes.filter(c=>!((c.origem===d.id&&+c.portaOrigem===num)||(c.destino===d.id&&+c.portaDestino===num)));
    if(remote&&rport){state.conexoes.push({origem:d.id,portaOrigem:num,destino:remote,portaDestino:rport,capacidade:cap,tipo:type});p.status="conectada";}
  });
  persist();detailEditMode=false;document.getElementById("inlineEditActions").classList.add("hidden");renderAll();openDetail(d.id);
}
function cancelInlineEdit(){
  if(detailBackup){const o=detailBackup.equipamento,i=state.equipamentos.findIndex(e=>e.id===o.id);if(i>=0)state.equipamentos[i]=o;state.conexoes=detailBackup.conexoes;}
  detailEditMode=false;document.getElementById("inlineEditActions").classList.add("hidden");renderDetailRows(getDevice(currentDeviceId));
}
function closeModal(){if(detailEditMode)cancelInlineEdit();document.getElementById("modal").classList.add("hidden");}

function openNetworkManager(){
  document.getElementById("networkManager").classList.remove("hidden");renderManager("equipamentos");
}
function closeNetworkManager(){document.getElementById("networkManager").classList.add("hidden");}
function renderManager(tab){
  document.querySelectorAll(".manager-tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  const box=document.getElementById("managerContent");
  if(tab==="equipamentos"){
    box.innerHTML=`<div class="manager-toolbar"><button class="primary-btn" id="addEquipment">+ Novo equipamento</button><button class="btn" id="downloadAll">Baixar JSON</button><span class="manager-hint">Use <b>Visualizar</b> para abrir o painel frontal interativo.</span></div>
      <div class="manager-list">${state.equipamentos.map((e,i)=>`<div class="manager-item manager-equipment-item"><div class="manager-equipment-info"><b>${escapeHtml(e.nome)}</b><small>${escapeHtml(e.modelo||"")} • ${e.portas.length} portas • ${e.portas.filter(p=>getPortConnection(e.id,p.numero)).length} conectadas</small></div><div class="manager-item-actions"><button class="btn mgr-visual" data-i="${i}">◉ Visualizar</button><button class="icon-edit mgr-edit" data-i="${i}" title="Editar equipamento">✎</button><button class="danger-btn mgr-del" data-i="${i}">Excluir</button></div></div>`).join("")}</div>`;
    document.getElementById("addEquipment").onclick=()=>editEquipment(-1);document.getElementById("downloadAll").onclick=downloadAll;
    box.querySelectorAll(".mgr-edit").forEach(b=>b.onclick=()=>editEquipment(+b.dataset.i));
    box.querySelectorAll(".mgr-visual").forEach(b=>b.onclick=()=>openEquipmentVisual(+b.dataset.i));
    box.querySelectorAll(".mgr-del").forEach(b=>b.onclick=()=>deleteEquipment(+b.dataset.i));
  }else{
    box.innerHTML=`<div class="manager-toolbar"><button class="primary-btn" id="addPop">+ Novo POP</button></div>
      <div class="manager-list">${state.pops.map((p,i)=>`<div class="manager-item"><div><b>${escapeHtml(p.nome)}</b><small>${p.equipamentos.length} aparelhos • ${p.rotas.length} rotas</small></div><div><button class="icon-edit mgr-pop-edit" data-i="${i}">✎</button><button class="danger-btn mgr-pop-del" data-i="${i}">Excluir</button></div></div>`).join("")}</div>`;
    document.getElementById("addPop").onclick=()=>editPop(-1);box.querySelectorAll(".mgr-pop-edit").forEach(b=>b.onclick=()=>editPop(+b.dataset.i));box.querySelectorAll(".mgr-pop-del").forEach(b=>b.onclick=()=>deletePop(+b.dataset.i));
  }
}

let visualEquipmentIndex = -1;
let visualSelectedPort = null;

function portVisualState(e,p){
  const conn=getPortConnection(e.id,p.numero);
  if(conn) return "connected";
  const st=(p.status||"livre").toLowerCase();
  if(st.includes("reserv")) return "reserved";
  if(st.includes("manut")) return "maintenance";
  return "free";
}
function portConnectionLabel(e,p){
  const info=getPortConnection(e.id,p.numero);
  if(!info) return "Livre";
  const c=info.c;
  const remote=info.isOrigin?getDevice(c.destino):getDevice(c.origem);
  const remoteName=remote?.nome || (info.isOrigin?c.destino:c.origem);
  const remotePort=info.isOrigin?c.portaDestino:c.portaOrigem;
  return `${remoteName} • porta ${remotePort}`;
}
function openEquipmentVisual(index){
  const e=state.equipamentos[index]; if(!e)return;
  visualEquipmentIndex=index; visualSelectedPort=null;
  document.getElementById("visualEquipmentName").textContent=e.nome;
  document.getElementById("visualEquipmentMeta").textContent=`${e.modelo||"Modelo não informado"} • ${e.local||"Local não informado"}`;
  document.getElementById("visualEquipmentEdit").onclick=()=>{closeEquipmentVisual();editEquipment(index);};
  renderEquipmentFront(e);
  document.getElementById("equipmentVisual").classList.remove("hidden");
}
function closeEquipmentVisual(){document.getElementById("equipmentVisual").classList.add("hidden");visualEquipmentIndex=-1;visualSelectedPort=null;}
function renderEquipmentFront(e){
  const front=document.getElementById("equipmentFront");
  const ports=Array.isArray(e.portas)?e.portas:[];
  const connected=ports.filter(p=>getPortConnection(e.id,p.numero)).length;
  document.getElementById("visualPortSummary").textContent=`${ports.length} portas • ${connected} conectadas`;
  const cols=ports.length<=12?Math.max(1,ports.length):ports.length<=24?12:ports.length<=48?12:14;
  front.innerHTML=`
    <div class="equipment-rack-shell">
      <div class="rack-ear left"></div><div class="rack-ear right"></div>
      <div class="rack-brand"><span>${escapeHtml(e.fabricante||e.modelo?.split(" ")[0]||"NETWORK")}</span><b>${escapeHtml(e.nome)}</b><small>${escapeHtml(e.modelo||"")}</small></div>
      <div class="rack-display"><span>NETWORK</span><i></i><i></i><i></i></div>
      <div class="rack-port-grid" style="--port-cols:${cols}"
        aria-label="Portas do equipamento">${ports.map(p=>{
          const st=portVisualState(e,p), conn=portConnectionLabel(e,p);
          return `<button type="button" class="rack-port ${st}" data-port="${escapeAttr(p.numero)}" title="Porta ${escapeAttr(p.numero)} • ${escapeAttr(p.capacidade||"Capacidade não informada")} • ${escapeAttr(p.tipo||"Tipo não informado")} • ${escapeAttr(conn)}"><span>${escapeHtml(p.numero)}</span><i></i></button>`;
        }).join("")}</div>
      <div class="rack-vents"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>`;
  front.querySelectorAll(".rack-port").forEach(btn=>{
    const show=()=>selectVisualPort(e,+btn.dataset.port);
    btn.addEventListener("mouseenter",show);
    btn.addEventListener("focus",show);
    btn.addEventListener("click",show);
  });
  if(ports.length)selectVisualPort(e,ports[0].numero);
}
function selectVisualPort(e,portNumber){
  const p=e.portas.find(x=>+x.numero===+portNumber); if(!p)return;
  visualSelectedPort=portNumber;
  document.querySelectorAll("#equipmentFront .rack-port").forEach(b=>b.classList.toggle("selected",+b.dataset.port===+portNumber));
  const info=getPortConnection(e.id,p.numero),c=info?.c,remote=info?(info.isOrigin?getDevice(c.destino):getDevice(c.origem)):null;
  const status=portVisualState(e,p);
  const statusLabel={free:"Livre",connected:"Conectada",reserved:"Reservada",maintenance:"Manutenção"}[status]||p.status||"Livre";
  const remoteText=info?`${remote?.nome|| (info.isOrigin?c.destino:c.origem)} • porta ${info.isOrigin?c.portaDestino:c.portaOrigem}`:"Nenhuma conexão cadastrada";
  const inspector=document.getElementById("portInspector");
  inspector.innerHTML=`<div class="port-inspector-head"><div><span>PORTA</span><h3>${escapeHtml(String(p.numero))}</h3></div><span class="port-status ${status}">${statusLabel}</span></div>
    <div class="port-info-grid">
      <div><small>Capacidade</small><b>${escapeHtml(p.capacidade||c?.capacidade||"Não informada")}</b></div>
      <div><small>Tipo</small><b>${escapeHtml(p.tipo||c?.tipo||"Não informado")}</b></div>
      <div class="wide"><small>Conectado a</small><b>${escapeHtml(remoteText)}</b></div>
      <div class="wide"><small>Observação</small><b>${escapeHtml(p.observacao||"—")}</b></div>
    </div>
    <div class="port-inspector-actions"><button class="primary-btn" id="visualEditPort">✎ Editar porta</button></div>`;
  document.getElementById("visualEditPort").onclick=()=>editVisualPort(e,p.numero);
}
function editVisualPort(e,portNumber){
  closeEquipmentVisual();
  const index=state.equipamentos.findIndex(x=>x.id===e.id);
  if(index<0)return;
  openUniversalEditor("equipment",index);
  setTimeout(()=>{
    const row=[...document.querySelectorAll("#editorPortRows tr")].find(tr=>+tr.querySelector(".ep-number")?.value===+portNumber);
    if(row){row.scrollIntoView({block:"center"});row.classList.add("port-edit-highlight");row.querySelector(".ep-cap")?.focus();}
  },80);
}

function deleteEquipment(i){
  const e=state.equipamentos[i];if(!e||!confirm(`Excluir ${e.nome}?`))return;
  state.conexoes=state.conexoes.filter(c=>c.origem!==e.id&&c.destino!==e.id);
  state.equipamentos.splice(i,1);state.pops.forEach(p=>p.equipamentos=p.equipamentos.filter(x=>x.id!==e.id));persist();renderAll();renderManager("equipamentos");
}
function deletePop(i){if(!confirm(`Excluir ${state.pops[i]?.nome||"POP"}?`))return;state.pops.splice(i,1);persist();renderAll();renderManager("pops");}
function downloadAll(){
  downloadJson("equipamentos.json",state.equipamentos);setTimeout(()=>downloadJson("conexoes.json",state.conexoes),150);setTimeout(()=>downloadJson("pops.json",state.pops),300);
}
function downloadJson(name,data){const a=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
function showConnection(c){
  const a=getDevice(c.origem),b=getDevice(c.destino);document.getElementById("connectionInfo").innerHTML=`<div class="connection-card"><div class="connection-side"><b>${escapeHtml(a?.nome||c.origem)}</b><span>Porta ${c.portaOrigem}</span></div><div class="connection-arrow">→</div><div class="connection-side"><b>${escapeHtml(b?.nome||c.destino)}</b><span>Porta ${c.portaDestino}</span></div><div class="connection-meta">${escapeHtml(c.capacidade||"")} • ${escapeHtml(c.tipo||"")}</div></div>`;document.getElementById("connectionPanel").classList.remove("hidden");
}
function closeConnection(){document.getElementById("connectionPanel").classList.add("hidden");}
function escapeAttr(v){return escapeHtml(v).replace(/`/g,"&#096;");}
function escapeHtml(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}


let universalEditorMode = null;
let universalEditorIndex = null;
let universalEditorBackup = null;

const visibleConfig = {
  coreTitle: "BACKBONE • ANEL ÓPTICO",
  ringTitle: "ANEL ÓPTICO DOS POPs",
  ringLabel: "ANEL — ROTAS AÉREAS E SUBTERRÂNEAS",
  popSectionTitle: "EQUIPAMENTOS POR POP",
  subtitle: "Topologia de Rede • Ascenty / BGP / MPLS"
};

function getConfig() {
  const saved = localStorage.getItem("updown-topologia-config");
  if (saved) {
    try { Object.assign(visibleConfig, JSON.parse(saved)); } catch (_) {}
  }
  return visibleConfig;
}
function saveConfig() {
  localStorage.setItem("updown-topologia-config", JSON.stringify(visibleConfig));
  applyConfig();
}
function applyConfig() {
  const c = getConfig();
  document.getElementById("topSubtitle").textContent = c.subtitle;
  document.getElementById("coreTitle").textContent = c.coreTitle;
  document.getElementById("ringTitle").textContent = c.ringTitle;
  document.getElementById("ringLabel").textContent = c.ringLabel;
  document.getElementById("popSectionTitle").textContent = c.popSectionTitle;
}
function field(label, value, name, type="text", extra="") {
  return `<label class="editor-field"><span>${escapeHtml(label)}</span><input type="${type}" name="${escapeAttr(name)}" value="${escapeAttr(value ?? "")}" ${extra}></label>`;
}
function textareaField(label, value, name) {
  return `<label class="editor-field editor-wide"><span>${escapeHtml(label)}</span><textarea name="${escapeAttr(name)}" rows="3">${escapeHtml(value ?? "")}</textarea></label>`;
}
function selectField(label, value, name, options) {
  return `<label class="editor-field"><span>${escapeHtml(label)}</span><select name="${escapeAttr(name)}">${options.map(o=>`<option value="${escapeAttr(o)}" ${o===value?"selected":""}>${escapeHtml(o)}</option>`).join("")}</select></label>`;
}

function openUniversalEditor(mode, index=-1) {
  universalEditorMode = mode;
  universalEditorIndex = index;
  universalEditorBackup = JSON.parse(JSON.stringify({
    equipamentos: state.equipamentos,
    conexoes: state.conexoes,
    pops: state.pops,
    config: getConfig()
  }));

  const body = document.getElementById("universalEditorBody");
  const title = document.getElementById("editorTitle");
  const subtitle = document.getElementById("editorSubtitle");

  if (mode === "equipment") {
    const e = index >= 0 ? state.equipamentos[index] :
      {id:"eq-"+Date.now(),nome:"Novo equipamento",modelo:"",categoria:"Equipamento",nucleo:"",local:"",observacao:"",portas:[]};
    title.textContent = index >= 0 ? "EDITAR EQUIPAMENTO" : "NOVO EQUIPAMENTO";
    subtitle.textContent = "Todas as informações exibidas para este equipamento podem ser alteradas.";
    body.innerHTML = `
      <div class="editor-grid">
        ${field("Nome do equipamento",e.nome,"nome")}
        ${field("Modelo",e.modelo,"modelo")}
        ${field("Categoria / tipo",e.categoria,"categoria")}
        ${field("Núcleo / rede",e.nucleo || e.nucleoRede || "","nucleo")}
        ${field("Local / POP",e.local,"local")}
        ${field("Fabricante",e.fabricante || "","fabricante")}
        ${field("IP / gerenciamento",e.ip || e.ipGerencia || "","ip")}
        ${field("Quantidade de portas",e.portas.length,"portaCount","number","min=\"0\"")}
        ${field("Rack / posição",e.rack || "","rack")}
        ${field("VLAN / identificação",e.vlan || "","vlan")}
        ${textareaField("Observação",e.observacao,"observacao")}
        ${textareaField("Descrição exibida","", "descricao")}
      </div>
      <div class="editor-section-title">PORTAS</div>
      <div class="editor-port-toolbar">
        <button type="button" class="btn" id="addPortEditor">+ Adicionar porta</button>
        <span>Você pode editar cada campo abaixo. A quantidade de portas também pode ser alterada.</span>
      </div>
      <div class="editor-port-table-wrap">
        <table class="editor-port-table">
          <thead><tr><th>#</th><th>Capacidade</th><th>Tipo</th><th>Status</th><th>Conectado a / string</th><th>Porta remota</th><th>Observação</th><th></th></tr></thead>
          <tbody id="editorPortRows"></tbody>
        </table>
      </div>`;
    body.querySelector('[name="descricao"]').value = e.descricao || "";
    renderEditorPorts(e);
    document.getElementById("addPortEditor").onclick = () => {
      e.portas.push({numero: e.portas.length+1, capacidade:"", tipo:"", status:"livre", observacao:""});
      renderEditorPorts(e);
    };
  } else if (mode === "pop") {
    const p = index >= 0 ? state.pops[index] : {id:"pop-"+Date.now(),nome:"Novo POP",rotas:[],local:"",cidade:"",nucleo:"",observacao:"",equipamentos:[]};
    title.textContent = index >= 0 ? "EDITAR POP" : "NOVO POP";
    subtitle.textContent = "Altere todas as informações visíveis e os equipamentos deste POP.";
    body.innerHTML = `
      <div class="editor-grid">
        ${field("Nome do POP",p.nome,"nome")}
        ${field("Local",p.local || "","local")}
        ${field("Cidade / região",p.cidade || "","cidade")}
        ${field("Núcleo / anel",p.nucleo || "","nucleo")}
        ${field("Rotas do anel","", "rotas")}
        ${textareaField("Observação",p.observacao,"observacao")}
      </div>
      <div class="editor-section-title">APARELHOS DO POP</div>
      <div class="editor-port-toolbar">
        <button type="button" class="btn" id="addPopEquipmentEditor">+ Adicionar aparelho</button>
        <span>Os aparelhos cadastrados aqui também ficam disponíveis para edição completa.</span>
      </div>
      <div id="popEquipmentEditorList" class="pop-editor-list"></div>`;
    body.querySelector('[name="rotas"]').value = p.rotas.join(", ");
    renderPopEquipmentEditor(p);
    document.getElementById("addPopEquipmentEditor").onclick = () => {
      p.equipamentos.push({id:"pop-eq-"+Date.now(),nome:"Novo aparelho",modelo:"",observacao:"",portas:[]});
      renderPopEquipmentEditor(p);
    };
  } else if (mode === "config") {
    const c = getConfig();
    title.textContent = "EDITAR INFORMAÇÕES DA TELA";
    subtitle.textContent = "Todos os títulos e textos principais visíveis na topologia podem ser personalizados.";
    body.innerHTML = `<div class="editor-grid">
      ${field("Subtítulo do cabeçalho",c.subtitle,"subtitle")}
      ${field("Título do núcleo",c.coreTitle,"coreTitle")}
      ${field("Título do anel óptico",c.ringTitle,"ringTitle")}
      ${field("Descrição do anel",c.ringLabel,"ringLabel")}
      ${field("Título dos equipamentos por POP",c.popSectionTitle,"popSectionTitle")}
    </div>`;
  }
  document.getElementById("universalEditor").classList.remove("hidden");
}

function renderEditorPorts(e) {
  const tbody=document.getElementById("editorPortRows");
  if(!tbody)return;
  tbody.innerHTML=e.portas.map((p,i)=>{
    const info=getPortConnection(e.id,p.numero), c=info?.c;
    const remoteId=c?(info.isOrigin?c.destino:c.origem):"";
    const remotePort=c?(info.isOrigin?c.portaDestino:c.portaOrigem):"";
    return `<tr data-index="${i}">
      <td><input class="ep-number" type="number" min="1" value="${escapeAttr(p.numero)}"></td>
      <td><input class="ep-cap" value="${escapeAttr(c?.capacidade||p.capacidade||"")}"></td>
      <td><input class="ep-type" value="${escapeAttr(c?.tipo||p.tipo||"")}"></td>
      <td>${selectField("",c?"conectada":(p.status||"livre"),"status",["livre","conectada","reservada","manutencao"])}</td>
      <td><input class="ep-remote" value="${escapeAttr(remoteId)}" placeholder="Equipamento / string"></td>
      <td><input class="ep-rport" value="${escapeAttr(remotePort)}" placeholder="Porta"></td>
      <td><input class="ep-note" value="${escapeAttr(p.observacao||"")}"></td>
      <td><button class="danger-btn ep-del" type="button">×</button></td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll(".ep-del").forEach(b=>b.onclick=()=>{
    const tr=b.closest("tr"); e.portas.splice(+tr.dataset.index,1);
    e.portas.forEach((p,i)=>p.numero=i+1); renderEditorPorts(e);
  });
}

function renderPopEquipmentEditor(p) {
  const box=document.getElementById("popEquipmentEditorList"); if(!box)return;
  box.innerHTML=p.equipamentos.map((e,i)=>`
    <div class="pop-editor-item">
      <div class="pop-editor-main">
        ${field("Nome",e.nome,`pe-${i}-nome`)}
        ${field("Modelo",e.modelo,`pe-${i}-modelo`)}
        ${field("Núcleo / rede",e.nucleo||"",`pe-${i}-nucleo`)}
        ${field("Local",e.local||p.local||"",`pe-${i}-local`)}
        ${field("Quantidade de portas",Array.isArray(e.portas)?e.portas.length:0,`pe-${i}-count`,"number","min=\"0\"")}
        ${textareaField("Observação",e.observacao,`pe-${i}-obs`)}
      </div>
      <div class="pop-editor-actions">
        <button class="icon-edit pop-open-equipment" type="button" data-index="${i}" title="Editar todas as portas">✎ Portas</button>
        <button class="danger-btn pop-remove-equipment" type="button" data-index="${i}">Excluir</button>
      </div>
    </div>`).join("");
  box.querySelectorAll(".pop-open-equipment").forEach(b=>b.onclick=()=>{
    const i=+b.dataset.index;
    const temp=Object.assign({id:p.equipamentos[i].id||"pop-eq-"+Date.now()},p.equipamentos[i]);
    // Put POP equipment into the main equipment registry if it is not there, so it can use the same editor.
    let idx=state.equipamentos.findIndex(x=>x.id===temp.id);
    if(idx<0){state.equipamentos.push(temp);idx=state.equipamentos.length-1;}
    closeUniversalEditor();
    openUniversalEditor("equipment",idx);
  });
  box.querySelectorAll(".pop-remove-equipment").forEach(b=>b.onclick=()=>{
    p.equipamentos.splice(+b.dataset.index,1);renderPopEquipmentEditor(p);
  });
}

function applyUniversalEditor() {
  const body=document.getElementById("universalEditorBody");
  if(universalEditorMode==="config"){
    Object.keys(visibleConfig).forEach(k=>{
      const el=body.querySelector(`[name="${k}"]`); if(el)visibleConfig[k]=el.value;
    });
    saveConfig(); return;
  }
  if(universalEditorMode==="equipment"){
    const i=universalEditorIndex;
    let e=i>=0?state.equipamentos[i]:{id:"eq-"+Date.now(),portas:[]};
    ["nome","modelo","categoria","nucleo","local","fabricante","ip","rack","vlan","observacao","descricao"].forEach(k=>{
      const el=body.querySelector(`[name="${k}"]`);if(el)e[k]=el.value;
    });
    const count=Math.max(0,parseInt(body.querySelector('[name="portaCount"]').value||"0",10));
    while(e.portas.length<count)e.portas.push({numero:e.portas.length+1,capacidade:"",tipo:"",status:"livre",observacao:""});
    e.portas=e.portas.slice(0,count);
    [...body.querySelectorAll("#editorPortRows tr")].forEach((tr,idx)=>{
      const p=e.portas[idx];if(!p)return;
      p.numero=parseInt(tr.querySelector(".ep-number").value,10)||idx+1;
      p.capacidade=tr.querySelector(".ep-cap").value;
      p.tipo=tr.querySelector(".ep-type").value;
      p.status=tr.querySelector("select[name='status']").value;
      p.observacao=tr.querySelector(".ep-note").value;
      const remote=tr.querySelector(".ep-remote").value.trim(), rport=tr.querySelector(".ep-rport").value.trim();
      state.conexoes=state.conexoes.filter(c=>!((c.origem===e.id&&+c.portaOrigem===+p.numero)||(c.destino===e.id&&+c.portaDestino===+p.numero)));
      if(remote&&rport)state.conexoes.push({origem:e.id,portaOrigem:p.numero,destino:remote,portaDestino:rport,capacidade:p.capacidade,tipo:p.tipo});
    });
    if(i<0)state.equipamentos.push(e);else state.equipamentos[i]=e;
  } else if(universalEditorMode==="pop"){
    const i=universalEditorIndex;
    let p=i>=0?state.pops[i]:{id:"pop-"+Date.now(),equipamentos:[]};
    ["nome","local","cidade","nucleo","observacao"].forEach(k=>{const el=body.querySelector(`[name="${k}"]`);if(el)p[k]=el.value;});
    p.rotas=(body.querySelector('[name="rotas"]').value||"").split(",").map(x=>x.trim()).filter(Boolean);
    p.equipamentos.forEach((e,i)=>{
      const get=n=>body.querySelector(`[name="pe-${i}-${n}"]`);
      if(get("nome"))e.nome=get("nome").value;
      if(get("modelo"))e.modelo=get("modelo").value;
      if(get("nucleo"))e.nucleo=get("nucleo").value;
      if(get("local"))e.local=get("local").value;
      if(get("obs"))e.observacao=get("obs").value;
      const count=Math.max(0,parseInt(get("count")?.value||String(e.portas?.length||0),10));
      e.portas=Array.isArray(e.portas)?e.portas:[];
      while(e.portas.length<count)e.portas.push({numero:e.portas.length+1,capacidade:"",tipo:"",status:"livre"});
      e.portas=e.portas.slice(0,count);
      if(e.id){
        const idx=state.equipamentos.findIndex(x=>x.id===e.id);
        if(idx>=0)state.equipamentos[idx]=e;
      }
    });
    if(i<0)state.pops.push(p);else state.pops[i]=p;
  }
  normalizeState(); persist(); renderAll();
}

function closeUniversalEditor() {
  document.getElementById("universalEditor").classList.add("hidden");
  universalEditorMode=null; universalEditorIndex=null; universalEditorBackup=null;
}

function cancelUniversalEditor() {
  if(universalEditorBackup) {
    state.equipamentos=universalEditorBackup.equipamentos;
    state.conexoes=universalEditorBackup.conexoes;
    state.pops=universalEditorBackup.pops;
    Object.assign(visibleConfig,universalEditorBackup.config);
    applyConfig();
  }
  closeUniversalEditor(); renderAll();
}

function editEquipment(i){openUniversalEditor("equipment",i);}
function editPop(i){openUniversalEditor("pop",i);}
function editCurrentDeviceAll(){ if(currentDeviceId!==null) { closeModal(); openUniversalEditor("equipment",state.equipamentos.findIndex(e=>e.id===currentDeviceId)); } }
function editConfig(){openUniversalEditor("config",0);}


/* =========================================================
   TEMA AUTOMÁTICO — SEGUE A PREFERÊNCIA DO DISPOSITIVO
   Não existe seletor manual. A interface sempre acompanha
   prefers-color-scheme do navegador/SO.
   ========================================================= */
function applySystemTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  document.documentElement.dataset.theme = media.matches ? "dark" : "light";
  document.documentElement.dataset.themePreference = "system";
}
function initTheme() {
  applySystemTheme();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => applySystemTheme();
  if (media.addEventListener) media.addEventListener("change", handler);
  else if (media.addListener) media.addListener(handler);
}


/* UX do editor: ESC fecha e o status indica alterações. */
function initUniversalEditorUX(){
  const modal=document.getElementById("universalEditor");
  if(!modal) return;

  modal.addEventListener("input",()=>{
    const status=document.getElementById("universalEditorStatus");
    if(status) status.textContent="Alterações não salvas";
  });

  document.addEventListener("keydown",(e)=>{
    if(e.key==="Escape" && !modal.classList.contains("hidden")){
      e.preventDefault();
      cancelUniversalEditor();
    }
  });
}

document.getElementById("search")?.addEventListener("input",e=>renderSidebar(e.target.value));
document.getElementById("closeBtn")?.addEventListener("click",closeModal);
document.getElementById("editCurrentDevice")?.addEventListener("click",editCurrentDeviceAll);
document.getElementById("inlineEditSave")?.addEventListener("click",saveInlineEdit);
document.getElementById("inlineEditCancel")?.addEventListener("click",cancelInlineEdit);
document.getElementById("popModalClose")?.addEventListener("click",closePop);
document.getElementById("editCurrentPop")?.addEventListener("click",()=>editPop(state.pops.findIndex(p=>p.id===currentPopId)));
document.getElementById("connectionClose")?.addEventListener("click",closeConnection);
document.getElementById("manageNetworkBtn")?.addEventListener("click",openNetworkManager);
document.getElementById("networkManagerClose")?.addEventListener("click",closeNetworkManager);
document.getElementById("equipmentVisualClose")?.addEventListener("click",closeEquipmentVisual);
document.getElementById("universalEditorClose")?.addEventListener("click",closeUniversalEditor);
document.getElementById("universalEditorCancel")?.addEventListener("click",cancelUniversalEditor);
document.getElementById("universalEditorSave")?.addEventListener("click",()=>{
  applyUniversalEditor();
  const status=document.getElementById("universalEditorStatus");
  if(status) status.textContent="Alterações salvas";
  closeUniversalEditor();
});
document.querySelectorAll(".section-pencil").forEach(b=>b.addEventListener("click",editConfig));

document.querySelectorAll(".manager-tab").forEach(b=>b.addEventListener("click",()=>renderManager(b.dataset.tab)));
document.getElementById("sidebarToggle")?.addEventListener("click",()=>{
  document.getElementById("appShell").classList.toggle("sidebar-collapsed");
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeModal();closePop();closeNetworkManager();closeEquipmentVisual();}});
initTheme();
initUniversalEditorUX();
loadData().catch(e=>{console.error(e);document.getElementById("topology").innerHTML=`<div class="empty">Erro ao carregar: ${escapeHtml(e.message)}</div>`;});
