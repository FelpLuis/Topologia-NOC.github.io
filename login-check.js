
const form=document.getElementById("loginForm");
const error=document.getElementById("error");
const username=document.getElementById("username");
const password=document.getElementById("password");

form.addEventListener("submit",async e=>{
  e.preventDefault();
  error.style.display="none";
  try{
    const r=await fetch("/api/auth/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:username.value.trim(),password:password.value})
    });
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||"Não foi possível entrar.");
    location.href=d.user.must_change_password?"/change-password.html":"/";
  }catch(err){
    error.textContent=err.message;
    error.style.display="block";
  }
});
fetch("/api/auth/me",{cache:"no-store"}).then(r=>r.json()).then(d=>{
  if(d.authenticated) location.href="/";
}).catch(()=>{});
