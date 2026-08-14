(async function(){
  const path=location.pathname;
  if(path==="/login.html"||path==="/change-password.html") return;

  try{
    const authResponse=await fetch("/api/auth/me",{cache:"no-store",credentials:"same-origin"});
    const authData=await authResponse.json();

    if(!authData.authenticated){
      location.href="/login.html";
      return;
    }

    window.UPDOWN_AUTH=authData.user;
    window.UPDOWN_CAN=(permission)=>fetch("/api/topology/permissions",{cache:"no-store",credentials:"same-origin"})
      .then(r=>r.json())
      .then(d=>Array.isArray(d.permissions)&&d.permissions.includes(permission));

    document.documentElement.dataset.role=authData.user.role;

    // Access control is loaded immediately after authentication.
    const accessResponse=await fetch("/api/access",{cache:"no-store",credentials:"same-origin"});
    const access=await accessResponse.json();
    window.UPDOWN_ACCESS=access;

    const screens=Array.isArray(access.screens)?access.screens:[];
    const platform=document.getElementById("platformBtn");
    const dashboard=document.getElementById("dashboardBtn");
    const manageNetwork=document.getElementById("manageNetworkBtn");

    if(platform){
      if(screens.some(s=>s.code==="platform")){
        platform.classList.remove("hidden");
        platform.onclick=()=>location.href="/platform.html";
      }else{
        platform.classList.add("hidden");
      }
    }

    if(dashboard && !screens.some(s=>s.code==="dashboard"))
      dashboard.classList.add("hidden");

    if(manageNetwork && !screens.some(s=>s.code==="network"))
      manageNetwork.classList.add("hidden");

    if(location.pathname==="/dashboard.html" && !screens.some(s=>s.code==="dashboard")){
      location.href="/";
      return;
    }

    if(location.pathname==="/platform.html" && !screens.some(s=>s.code==="platform")){
      location.href="/";
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
