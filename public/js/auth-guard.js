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