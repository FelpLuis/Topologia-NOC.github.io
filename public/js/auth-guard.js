(function(){
  const path=location.pathname;
  if(path==="/login.html"||path==="/change-password.html") return;

  // Bind logout immediately, before authentication/access requests finish.
  // This prevents the button from becoming inert when /api/access has an error.
  function bindLogout(){
    const logout=document.getElementById("logoutBtn");
    if(!logout || logout.dataset.logoutBound === "1") return;
    logout.dataset.logoutBound = "1";
    logout.addEventListener("click", async (event)=>{
      event.preventDefault();
      if(logout.dataset.loggingOut === "1") return;
      logout.dataset.loggingOut = "1";
      logout.disabled = true;
      logout.classList.add("is-loading");
      try{
        const response = await fetch("/api/auth/logout", {
          method:"POST",
          credentials:"same-origin",
          cache:"no-store",
          headers:{"Content-Type":"application/json"}
        });
        if(!response.ok) console.error("Logout retornou HTTP", response.status);
      }catch(e){
        console.error("Falha ao encerrar sessão:",e);
      }finally{
        // Never leave the user on the authenticated page. The Worker clears
        // the HttpOnly cookie; the redirect also prevents stale UI state.
        window.location.replace("/login.html?logged_out=1");
      }
    });
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindLogout, {once:true});
  else bindLogout();

  /* Sessão e acesso saem juntos, não em fila.
     `/api/access` já exige sessão válida no servidor e responde 401 sem ela,
     então esperar `/api/auth/me` responder antes de pedi-lo só acrescentava um
     ida-e-volta ao caminho crítico de toda navegação entre telas.

     A Promise fica em UPDOWN_ACCESS_PROMISE para que noc-api.js reaproveite
     esta resposta em vez de pedir /api/access uma segunda vez. */
  const pedidoSessao=fetch("/api/auth/me",{cache:"no-store",credentials:"same-origin"})
    .then(r=>r.json());
  const pedidoAcesso=fetch("/api/access",{cache:"no-store",credentials:"same-origin"})
    .then(r=>r.ok?r.json():Promise.reject(new Error("ACESSO_INDISPONIVEL")));

  window.UPDOWN_ACCESS_PROMISE=pedidoAcesso;
  // Sem este catch, uma falha aqui vira "unhandled rejection" antes de alguém
  // consumir a Promise. O erro real continua sendo tratado no fluxo abaixo.
  pedidoAcesso.catch(()=>{});

  (async function(){
  try{
    const authData=await pedidoSessao;

    if(!authData.authenticated){
      location.href="/login.html";
      return;
    }

    window.UPDOWN_AUTH=authData.user;
    window.UPDOWN_CAN=(permission)=>fetch("/api/topology/permissions",{cache:"no-store",credentials:"same-origin"})
      .then(r=>r.json())
      .then(d=>Array.isArray(d.permissions)&&d.permissions.includes(permission));

    document.documentElement.dataset.role=authData.user.role;

    const access=await pedidoAcesso;
    window.UPDOWN_ACCESS=access;

    const screens=Array.isArray(access.screens)?access.screens:[];
    const catalogo=Array.isArray(access.allScreens)?access.allScreens:[];
    const liberadas=new Set(screens.map(s=>s.code));

    const platform=document.getElementById("platformBtn");
    const dashboard=document.getElementById("dashboardBtn");
    const manageNetwork=document.getElementById("manageNetworkBtn");
    if(platform){
      if(liberadas.has("platform")){
        platform.classList.remove("hidden");
        platform.onclick=()=>location.href="/platform.html";
      }else{
        platform.classList.add("hidden");
      }
    }

    if(dashboard && !liberadas.has("dashboard")) dashboard.classList.add("hidden");
    if(manageNetwork && !liberadas.has("network")) manageNetwork.classList.add("hidden");

    /* Guardião genérico de rotas: toda tela declarada no catálogo é protegida
       pelo que o perfil tem marcado, sem lista fixa aqui dentro. */
    const normaliza=(rota)=>String(rota||"").replace(/\/index\.html$/,"/")||"/";
    const atual=normaliza(location.pathname);
    const tela=catalogo.find(s=>normaliza(s.route)===atual);

    if(tela && (!liberadas.has(tela.code) || !tela.active)){
      const destino=screens.find(s=>normaliza(s.route)!==atual);
      if(destino){
        location.replace(destino.route);
        return;
      }
      // Sem nenhuma tela liberada não há para onde mandar o usuário:
      // redirecionar aqui viraria laço infinito entre páginas negadas.
      document.body.innerHTML='<main style="max-width:520px;margin:12vh auto;padding:24px;font-family:system-ui,sans-serif;text-align:center">'
        +'<h1 style="font-size:20px;margin-bottom:8px">Sem telas liberadas</h1>'
        +'<p style="opacity:.75;line-height:1.5">O seu perfil não tem nenhuma tela habilitada. Fale com um administrador da plataforma.</p>'
        +'<p style="margin-top:20px"><a href="/login.html?logged_out=1" id="semAcessoSair">Sair</a></p></main>';
      document.getElementById("semAcessoSair").addEventListener("click", ()=>{
        fetch("/api/auth/logout",{method:"POST",credentials:"same-origin"}).catch(()=>{});
      });
      return;
    }

    window.dispatchEvent(new CustomEvent("updown:auth-ready",{
      detail:{user:authData.user,access}
    }));
  }catch(e){
    console.error("Falha ao inicializar autenticação:",e);
    location.href="/login.html";
  }
})();
})();
