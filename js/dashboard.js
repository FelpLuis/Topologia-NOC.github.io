const state={equipamentos:[],conexoes:[],pops:[]};

const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const device=id=>state.equipamentos.find(e=>e.id===id);
function connection(id,port){return state.conexoes.find(c=>(c.origem===id&&+c.portaOrigem===+port)||(c.destino===id&&+c.portaDestino===+port));}
function connectedPorts(e){return (e.portas||[]).filter(p=>connection(e.id,p.numero)).length}
function statusPorts(e){
  const total=(e.portas||[]).length, connected=connectedPorts(e), free=Math.max(0,total-connected);
  return {total,connected,free,pct:total?Math.round(connected/total*100):0}
}
function typeClass(e){const c=(e.categoria||"").toLowerCase();return c.includes("núcleo")||c.includes("nucleo")?"core":c.includes("agrega")?"agg":"transport"}

function renderKPIs(){
  let total=0,connected=0;
  state.equipamentos.forEach(e=>{total+=(e.portas||[]).length;connected+=connectedPorts(e)});
  document.getElementById("kpiDevices").textContent=state.equipamentos.length;
  document.getElementById("kpiPorts").textContent=total;
  document.getElementById("kpiConnected").textContent=connected;
  document.getElementById("kpiFree").textContent=Math.max(0,total-connected);
  document.getElementById("kpiFreePct").textContent=(total?Math.round((total-connected)/total*100):0)+"% da capacidade";
  document.getElementById("kpiLinks").textContent=state.conexoes.length;
  document.getElementById("kpiPops").textContent=state.pops.length;
}

function renderTopology(){
  const host=document.getElementById("topologyCanvas");
  const ordered=[...state.equipamentos].sort((a,b)=>{
    const rank={Núcleo:0,Agregação:1,Transporte:2};return (rank[a.categoria]??3)-(rank[b.categoria]??3)
  });
  const main=ordered.slice(0,7);
  const w=host.clientWidth,h=host.clientHeight;
  const positions=main.map((e,i)=>({e,x:w*(.10+i*(.80/Math.max(1,main.length-1))),y:h*(i%2?.57:.40)}));
  const svg=`<svg class="topology-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${state.conexoes.map(c=>{
      const a=positions.find(p=>p.e.id===c.origem),b=positions.find(p=>p.e.id===c.destino);
      return a&&b?`<line class="topo-line active" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`:"";
    }).join("")}
  </svg>`;
  host.innerHTML=svg+positions.map(p=>{
    const s=statusPorts(p.e);
    return `<div class="topo-node ${typeClass(p.e)}" style="left:${p.x}px;top:${p.y}px">
      <b>${esc(p.e.nome)}</b>
      <small>${esc(p.e.modelo||"Modelo não informado")}</small>
      <div class="node-meta"><span>${s.total} portas</span><span class="node-state">${s.connected} conectadas</span></div>
    </div>`
  }).join("");
}

function renderCapacity(){
  const list=document.getElementById("capacityList");
  list.innerHTML=state.equipamentos.map(e=>{
    const s=statusPorts(e);
    return `<div class="capacity-row">
      <div class="capacity-name">${esc(e.nome)}</div>
      <div class="capacity-bar"><div class="capacity-fill" style="width:${s.pct}%"></div></div>
      <div class="capacity-pct">${s.connected}/${s.total}</div>
    </div>`
  }).join("");
}

function renderStatus(){
  const connected=state.equipamentos.reduce((n,e)=>n+connectedPorts(e),0);
  const free=state.equipamentos.reduce((n,e)=>n+Math.max(0,(e.portas||[]).length-connectedPorts(e)),0);
  const pending=state.conexoes.filter(c=>String(c.capacidade||"").toLowerCase().includes("confirm")).length;
  document.getElementById("statusSummary").innerHTML=`
    <div class="status-box ok"><span>PORTAS CONECTADAS</span><strong>${connected}</strong></div>
    <div class="status-box"><span>PORTAS LIVRES</span><strong>${free}</strong></div>
    <div class="status-box ok"><span>ENLACES DOCUMENTADOS</span><strong>${state.conexoes.length}</strong></div>
    <div class="status-box warn"><span>A CONFIRMAR</span><strong>${pending}</strong></div>`;
}

function renderDevices(){
  document.getElementById("deviceGrid").innerHTML=state.equipamentos.map(e=>{
    const s=statusPorts(e);
    return `<div class="device-card">
      <b>${esc(e.nome)}</b>
      <small>${esc(e.modelo||"Modelo não informado")}</small>
      <div class="device-stats"><span>Portas <strong>${s.total}</strong></span><span>Uso <strong>${s.pct}%</strong></span></div>
    </div>`
  }).join("");
}

function renderPops(){
  document.getElementById("popGrid").innerHTML=state.pops.map(p=>{
    const ids=Array.isArray(p.equipamentos)?p.equipamentos:[];
    const names=ids.map(x=>device(typeof x==="string"?x:x.id)?.nome||x.nome||x).filter(Boolean);
    return `<div class="pop-card"><b>${esc(p.nome||"POP")}</b><small>${esc(p.local||p.descricao||"Ponto da rede")}</small>
      <div class="pop-eq">${names.slice(0,6).map(n=>`<span>${esc(n)}</span>`).join("")||"<span>Sem equipamentos cadastrados</span>"}</div>
    </div>`
  }).join("");
}

function updateClock(){
  const now=new Date();
  document.getElementById("clock").textContent=now.toLocaleTimeString("pt-BR",{hour12:false});
  document.getElementById("date").textContent=now.toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit",year:"numeric"}).toUpperCase();
}

async function load(){
  try{
    const cached=localStorage.getItem("updown-topologia-data");
    if(cached){
      Object.assign(state,JSON.parse(cached));
    }else{
      const [a,b,c]=await Promise.all([
        fetch("data/equipamentos.json"),fetch("data/conexoes.json"),fetch("data/pops.json")
      ]);
      state.equipamentos=await a.json();state.conexoes=await b.json();state.pops=await c.json();
    }
    state.equipamentos=Array.isArray(state.equipamentos)?state.equipamentos:[];
    state.conexoes=Array.isArray(state.conexoes)?state.conexoes:[];
    state.pops=Array.isArray(state.pops)?state.pops:[];
    renderKPIs();renderTopology();renderCapacity();renderStatus();renderDevices();renderPops();
    document.getElementById("lastUpdate").textContent="Atualizado "+new Date().toLocaleTimeString("pt-BR",{hour12:false});
    document.getElementById("footerStatus").textContent=cached?"Dados do navegador • sincronização local":"Dados da topologia";
  }catch(e){
    document.getElementById("footerStatus").textContent="Falha ao carregar dados";
    console.error(e);
  }
}

updateClock();setInterval(updateClock,1000);
load();
setInterval(load,30000);
window.addEventListener("resize",renderTopology);
window.addEventListener("storage",load);
