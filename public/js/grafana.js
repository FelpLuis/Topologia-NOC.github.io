/* Cliente da API do Worker / Grafana.
   Não coloque token do Grafana neste arquivo. */
window.UpdownGrafana = {
  async health() {
    const r = await fetch("/api/grafana/health", {cache:"no-store"});
    return r.json();
  },
  async query(payload) {
    const r = await fetch("/api/grafana/query", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload),
      cache:"no-store"
    });
    if (!r.ok) throw new Error(`Grafana HTTP ${r.status}`);
    return r.json();
  },
  async dashboard(uid) {
    const r = await fetch(`/api/grafana/dashboard/${encodeURIComponent(uid)}`, {cache:"no-store"});
    if (!r.ok) throw new Error(`Grafana HTTP ${r.status}`);
    return r.json();
  }
};
