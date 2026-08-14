// Diagnóstico rápido do ambiente Cloudflare.
// Execute no terminal com Node instalado: node login-check.js https://SEU-WORKER.workers.dev
const base = process.argv[2];
if (!base) {
  console.error("Uso: node login-check.js https://seu-worker.workers.dev");
  process.exit(1);
}
const urls = ["/api/health", "/api/auth/me", "/api/access", "/api/topology"];
for (const path of urls) {
  try {
    const r = await fetch(new URL(path, base));
    console.log(`${r.status} ${path}`);
    console.log(await r.text());
  } catch (e) {
    console.error(`ERRO ${path}:`, e.message);
  }
}
