(async function(){
  const path=location.pathname;
  if(path==="/login.html"||path==="/change-password.html") return;
  try{
    const r=await fetch("/api/auth/me",{cache:"no-store"});
    const d=await r.json();
    if(!d.authenticated){location.href="/login.html";return;}
    window.UPDOWN_AUTH=d.user;
    window.UPDOWN_CAN=(p)=>fetch("/api/topology/permissions").then(x=>x.json()).then(x=>x.permissions.includes(p));
    document.documentElement.dataset.role=d.user.role;
  }catch(e){location.href="/login.html";}
})();
(async function(){
  if(!window.UPDOWN_AUTH) return;
  try{
    const r=await fetch("/api/access",{cache:"no-store"});
    const access=await r.json();
    window.UPDOWN_ACCESS=access;
    const platform=document.getElementById("platformBtn");
    const dashboard=document.getElementById("dashboardBtn");
    const manageNetwork=document.getElementById("manageNetworkBtn");
    if(platform && access.screens.some(s=>s.code==="platform")){
      platform.classList.remove("hidden");
      platform.addEventListener("click",()=>location.href="/platform.html");
    }
    if(dashboard && !access.screens.some(s=>s.code==="dashboard")) dashboard.classList.add("hidden");
    if(manageNetwork && !access.screens.some(s=>s.code==="network")) manageNetwork.classList.add("hidden");
    // Respect screen visibility for direct navigation.
    if(location.pathname==="/dashboard.html" && !access.screens.some(s=>s.code==="dashboard")){
      location.href="/";
    }
    if(location.pathname==="/platform.html" && !access.screens.some(s=>s.code==="platform")){
      location.href="/";
    }
  }catch(e){}
})();
