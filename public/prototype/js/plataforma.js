/* ============================================================
   UPDOWN NOC — Administração da plataforma
   Perfis/permissões, telas, usuários e auditoria.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;
  const D = window.MOCK;

  const state = {
    tab: "perfis",
    role: D.roles[0],
    userQuery: "", userFilter: "todos",
    auditQuery: "", auditFilter: "todos",
  };

  const permsOf = (roleName) => new Set(D.rolePermissions[roleName] || []);
  const screensOf = (roleName) => new Set(D.roleScreens[roleName] || []);
  const isAdmin = UI.session().role === "administrador";

  /* ---------------- perfis ---------------- */
  function renderRoles() {
    $("#roleList").innerHTML = D.roles.map((r) => `
      <button class="role-item" type="button" data-role="${r.id}" aria-current="${state.role?.id === r.id}">
        <span class="row-between"><b>${esc(r.label || r.name)}</b><span class="badge">${r.users}</span></span>
        <small>${esc(r.description)}</small>
      </button>`).join("");
    $$("#roleList [data-role]").forEach((b) => (b.onclick = () => {
      state.role = D.roles.find((r) => r.id === +b.dataset.role);
      renderRoles();
      renderRoleEditor();
    }));
  }

  function renderRoleEditor() {
    const r = state.role;
    const host = $("#roleEditor");
    if (!r) {
      host.innerHTML = `<div class="empty"><span class="empty-icon">${icon("shield")}</span><b>Selecione um perfil</b><p>As permissões e as telas aparecem aqui.</p></div>`;
      return;
    }
    const perms = permsOf(r.name);
    const screens = screensOf(r.name);
    const protegido = r.name === "administrador";

    host.innerHTML = `
      <div class="card-head">
        <div>
          <span class="kicker">Perfil</span>
          <h2 style="margin-top:6px;text-transform:capitalize">${esc(r.label || r.name)}</h2>
          <p>${esc(r.description)}</p>
        </div>
        <div class="row wrap" style="gap:6px;justify-content:flex-end">
          <span class="badge badge-info">${perms.size} permissões</span>
          <span class="badge">${screens.size} telas</span>
          ${protegido ? '<span class="badge badge-ok">perfil protegido</span>' : ""}
        </div>
      </div>
      <div class="card-body stack">
        ${protegido ? `<div class="alert alert-info" style="animation:none">${icon("info")}
          <span>O perfil administrador mantém acesso total por definição do sistema. Ele não pode ser reduzido nem excluído — é a garantia de que sempre existe quem consiga reabrir o acesso.</span></div>` : ""}

        <div class="perm-grid">
          <div class="perm-box">
            <h3>Permissões</h3>
            ${D.permissions.map((p) => `
              <label class="checkbox">
                <input type="checkbox" data-perm="${p.id}" ${perms.has(p.id) ? "checked" : ""} ${protegido || !isAdmin ? "disabled" : ""}>
                <span><b class="mono">${esc(p.code)}</b><small>${esc(p.description)}</small></span>
              </label>`).join("")}
          </div>
          <div class="perm-box">
            <h3>Telas visíveis</h3>
            ${D.screens.map((s) => `
              <label class="checkbox">
                <input type="checkbox" data-screen="${s.id}" ${screens.has(s.id) && s.active ? "checked" : ""} ${!s.active || protegido || !isAdmin ? "disabled" : ""}>
                <span><b>${esc(s.name)}</b><small>${esc(s.route)} — ${esc(s.description)}${s.active ? "" : " (tela desativada)"}</small></span>
              </label>`).join("")}
          </div>
        </div>
      </div>
      <div class="card-foot" style="justify-content:space-between">
        <span class="dim" style="font-size:var(--fs-11)">${isAdmin ? "Somente o perfil administrador altera RBAC." : "Seu perfil não pode alterar RBAC."}</span>
        <span class="row">
          ${protegido || !isAdmin ? "" : `<button class="btn btn-danger btn-sm" id="delRole" type="button">${icon("trash")} Excluir perfil</button>`}
          <button class="btn btn-primary btn-sm" id="saveRole" type="button" ${protegido || !isAdmin ? "disabled" : ""}>Salvar alterações</button>
        </span>
      </div>`;

    const save = $("#saveRole");
    if (save) save.onclick = () => {
      D.rolePermissions[r.name] = $$("[data-perm]:checked", host).map((x) => +x.dataset.perm);
      D.roleScreens[r.name] = $$("[data-screen]:checked", host).map((x) => +x.dataset.screen);
      renderRoleEditor();
      renderScreens();
      toast("Perfil atualizado", { text: `${r.label || r.name}: permissões e telas gravadas e auditadas.`, type: "ok" });
    };

    const del = $("#delRole");
    if (del) del.onclick = () => askConfirm({
      title: `Excluir o perfil ${r.label || r.name}?`,
      text: `${r.users} usuário(s) usam este perfil e perderiam o acesso atual. Reatribua as contas antes de excluir.`,
      confirmLabel: "Excluir perfil",
      danger: true,
      onConfirm: () => toast("Exclusão registrada", { text: "No protótipo nada é gravado.", type: "warn" }),
    });
  }

  function openNewRole() {
    modal({
      labelledBy: "nrTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">RBAC</span><h2 id="nrTitle" style="margin-top:6px">Criar perfil</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field"><label for="rName">Nome do perfil</label><input class="input" id="rName" placeholder="Ex.: Supervisor NOC"></div>
          <div class="field"><label for="rDesc">Descrição</label><textarea class="textarea" id="rDesc" placeholder="O que este perfil pode fazer no dia a dia"></textarea></div>
          <div class="alert alert-info" style="animation:none">${icon("info")}
            <span>O perfil nasce sem nenhuma permissão. Você marca o que ele pode fazer logo depois de criar — nunca o contrário.</span></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A criação é auditada.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Criar perfil</button></span>
        </div>`,
      onMount: (host, close) => {
        $("[data-go]", host).onclick = () => {
          const nome = $("#rName", host).value.trim();
          if (!nome) return $("#rName", host).focus();
          const novo = { id: Date.now(), name: nome.toLowerCase().replace(/\s+/g, "-"), label: nome, description: $("#rDesc", host).value.trim() || "Perfil personalizado.", users: 0 };
          D.roles.push(novo);
          D.rolePermissions[novo.name] = [];
          D.roleScreens[novo.name] = [];
          state.role = novo;
          close();
          renderRoles();
          renderRoleEditor();
          toast("Perfil criado", { text: "Marque agora as permissões e as telas deste perfil.", type: "ok" });
        };
      },
    });
  }

  /* ---------------- usuários ---------------- */
  function filteredUsers() {
    const q = state.userQuery;
    return D.users.filter((u) => {
      if (state.userFilter === "ativos" && !u.active) return false;
      if (state.userFilter === "inativos" && u.active) return false;
      if (!q) return true;
      return (u.display_name + " " + u.username + " " + u.role + " " + u.email).toLowerCase().includes(q);
    });
  }

  function renderUsers() {
    const list = filteredUsers();
    $("#userCount").textContent = D.users.length;
    $("#userRows").innerHTML = list.length ? list.map((u) => `
      <tr>
        <td>
          <div class="row" style="gap:var(--s-3)">
            <span class="avatar">${esc(UI.initials(u.display_name))}</span>
            <span><b>${esc(u.display_name)}</b><br><small class="dim">${esc(u.username)} • ${esc(u.email)}</small></span>
          </div>
        </td>
        <td>
          <label class="sr-only" for="role-${u.id}">Perfil de ${esc(u.display_name)}</label>
          <select class="select" id="role-${u.id}" data-user-role="${u.id}" ${isAdmin ? "" : "disabled"}>
            ${D.roles.map((r) => `<option value="${esc(r.name)}" ${r.name === u.role ? "selected" : ""}>${esc(r.label || r.name)}</option>`).join("")}
          </select>
        </td>
        <td><span class="badge ${u.active ? "badge-ok" : "badge-danger"}"><i class="dot ${u.active ? "dot-ok" : "dot-danger"}"></i>${u.active ? "Ativo" : "Inativo"}</span></td>
        <td class="mono dim">${esc(u.last_login_at || "—")}</td>
        <td>
          <div class="row" style="gap:6px;justify-content:flex-end">
            <button class="btn btn-sm" type="button" data-reset="${u.id}" ${isAdmin ? "" : "disabled"}>Redefinir senha</button>
            <button class="btn btn-sm ${u.active ? "btn-danger" : ""}" type="button" data-toggle="${u.id}" ${isAdmin ? "" : "disabled"}>${u.active ? "Desativar" : "Ativar"}</button>
          </div>
        </td>
      </tr>`).join("") : `<tr><td colspan="5"><div class="empty">
        <span class="empty-icon">${icon("users")}</span><b>Nenhuma conta encontrada</b><p>Ajuste a busca ou o filtro de status.</p></div></td></tr>`;

    $$("[data-user-role]").forEach((sel) => (sel.onchange = () => {
      const u = D.users.find((x) => x.id === +sel.dataset.userRole);
      const antes = u.role;
      u.role = sel.value;
      toast(`Perfil de ${u.display_name} alterado`, {
        text: `${antes} → ${u.role}. Alteração auditada.`,
        type: "ok",
        action: { label: "Desfazer", run: () => { u.role = antes; renderUsers(); } },
      });
    }));

    $$("[data-toggle]").forEach((b) => (b.onclick = () => {
      const u = D.users.find((x) => x.id === +b.dataset.toggle);
      if (u.active) {
        askConfirm({
          title: `Desativar ${u.display_name}?`,
          text: "A conta perde o acesso imediatamente e as sessões abertas são encerradas. O histórico de auditoria é mantido.",
          confirmLabel: "Desativar conta",
          danger: true,
          onConfirm: () => { u.active = false; renderUsers(); toast("Conta desativada", { type: "warn" }); },
        });
      } else {
        u.active = true;
        renderUsers();
        toast("Conta reativada", { text: `${u.display_name} voltou a ter acesso.`, type: "ok" });
      }
    }));

    $$("[data-reset]").forEach((b) => (b.onclick = () => {
      const u = D.users.find((x) => x.id === +b.dataset.reset);
      askConfirm({
        title: `Redefinir a senha de ${u.display_name}?`,
        text: "Uma senha temporária é gerada e o usuário é obrigado a trocá-la no próximo acesso.",
        confirmLabel: "Gerar senha temporária",
        onConfirm: () => toast("Senha temporária gerada", { text: "Enviada para o e-mail corporativo. Troca obrigatória no primeiro acesso.", type: "ok" }),
      });
    }));
  }

  function openNewUser() {
    modal({
      labelledBy: "nuTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Contas</span><h2 id="nuTitle" style="margin-top:6px">Novo usuário</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="row" style="gap:var(--s-3);align-items:flex-start">
            <div class="field grow"><label for="uNome">Nome completo</label><input class="input" id="uNome" placeholder="Ex.: Ana Costa"></div>
            <div class="field grow"><label for="uUser">Usuário de acesso</label><input class="input" id="uUser" placeholder="a.costa"></div>
          </div>
          <div class="field"><label for="uMail">E-mail corporativo</label><input class="input" id="uMail" type="email" placeholder="a.costa@updown.com.br"></div>
          <div class="field"><label for="uRole">Perfil</label>
            <select class="select" id="uRole">${D.roles.map((r) => `<option value="${esc(r.name)}">${esc(r.label || r.name)}</option>`).join("")}</select>
            <span class="field-hint" id="roleHint"></span>
          </div>
          <div class="alert alert-info" style="animation:none">${icon("lock")}
            <span>A conta nasce com senha temporária e troca obrigatória no primeiro acesso.</span></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Criação auditada.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Criar usuário</button></span>
        </div>`,
      onMount: (host, close) => {
        const sel = $("#uRole", host);
        const hint = $("#roleHint", host);
        const paintHint = () => {
          const r = D.roles.find((x) => x.name === sel.value);
          const n = (D.rolePermissions[r.name] || []).length;
          hint.textContent = `${r.description} (${n} permissões)`;
        };
        sel.onchange = paintHint;
        paintHint();

        $("[data-go]", host).onclick = () => {
          const nome = $("#uNome", host).value.trim();
          const user = $("#uUser", host).value.trim();
          if (!nome || !user) return (nome ? $("#uUser", host) : $("#uNome", host)).focus();
          D.users.unshift({
            id: Date.now(), username: user, display_name: nome, role: sel.value,
            active: true, last_login_at: null, email: $("#uMail", host).value.trim() || `${user}@updown.com.br`,
          });
          close();
          renderUsers();
          toast("Usuário criado", { text: `${nome} recebeu o perfil ${sel.value} e uma senha temporária.`, type: "ok" });
        };
      },
    });
  }

  /* ---------------- telas ---------------- */
  function renderScreens() {
    $("#screenRows").innerHTML = D.screens.map((s) => {
      const perfis = D.roles.filter((r) => (D.roleScreens[r.name] || []).includes(s.id));
      return `<tr>
        <td><b>${esc(s.name)}</b><br><small class="dim mono">${esc(s.code)}</small></td>
        <td class="mono dim">${esc(s.route)}</td>
        <td class="dim">${esc(s.description)}</td>
        <td>${perfis.length ? perfis.map((r) => `<span class="badge">${esc(r.label || r.name)}</span>`).join(" ") : '<span class="dim">nenhum</span>'}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-screen-toggle="${s.id}" ${s.active ? "checked" : ""} ${isAdmin ? "" : "disabled"}>
            <span class="switch-track"></span>
            <span class="sr-only">Ativar a tela ${esc(s.name)}</span>
          </label>
        </td>
      </tr>`;
    }).join("");

    $$("[data-screen-toggle]").forEach((c) => (c.onchange = () => {
      const s = D.screens.find((x) => x.id === +c.dataset.screenToggle);
      s.active = c.checked;
      renderScreens();
      renderRoleEditor();
      toast(`${s.name} ${s.active ? "ativada" : "desativada"}`, {
        text: s.active ? "A tela volta a aparecer para os perfis autorizados." : "Ninguém consegue abrir a tela enquanto estiver desativada.",
        type: s.active ? "ok" : "warn",
        action: { label: "Desfazer", run: () => { s.active = !s.active; renderScreens(); renderRoleEditor(); } },
      });
    }));
  }

  /* ---------------- auditoria ---------------- */
  function renderAudit() {
    const q = state.auditQuery;
    const list = D.audit.filter((a) => {
      if (state.auditFilter !== "todos" && !a.action.startsWith(state.auditFilter)) return false;
      if (!q) return true;
      return JSON.stringify(a).toLowerCase().includes(q);
    });
    $("#auditCount").textContent = `${list.length} registro${list.length === 1 ? "" : "s"}`;
    $("#auditList").innerHTML = list.length ? list.map((a) => {
      const risco = /delete|failed|denied/.test(a.action);
      return `<article class="timeline-item ${risco ? "is-danger" : ""}">
        <time>${esc(a.created_at)}</time>
        <span class="timeline-rail"><i></i></span>
        <div class="timeline-body">
          <div class="row wrap" style="gap:var(--s-2)">
            <b>${esc(a.username)}</b>
            <span class="badge ${risco ? "badge-danger" : "badge-info"}">${esc(a.action)}</span>
          </div>
          <p>${esc(a.details)}</p>
          <div class="meta">
            <span>${esc(a.resource_type)} ${esc(a.resource_id)}</span>
            <span class="mono">IP ${esc(a.ip)}</span>
          </div>
        </div>
      </article>`;
    }).join("") : `<div class="empty"><span class="empty-icon">${icon("clock")}</span><b>Nenhum registro</b><p>Nenhuma ação corresponde ao filtro atual.</p></div>`;
  }

  /* ---------------- abas ---------------- */
  function setTab(tab) {
    state.tab = tab;
    $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
    ["perfis", "usuarios", "telas", "auditoria"].forEach((id) => ($("#painel-" + id).hidden = id !== tab));
  }

  /* ---------------- início ---------------- */
  UI.mountShell({ active: "plataforma" });
  $("#iconSearchUsers").innerHTML = icon("search");
  $("#iconSearchAudit").innerHTML = icon("search");
  $("#btnExport").innerHTML = icon("download") + " Exportar auditoria";
  $("#newRole").innerHTML = icon("plus") + " Criar perfil";
  $("#newUser").innerHTML = icon("plus") + " Novo usuário";

  renderRoles();
  renderRoleEditor();
  renderUsers();
  renderScreens();
  renderAudit();

  $$("[data-tab]").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
  $("#newRole").onclick = openNewRole;
  $("#newUser").onclick = openNewUser;
  $("#btnExport").onclick = () => toast("Exportação da auditoria", { text: "CSV com período, usuário, ação, recurso e IP.", type: "info" });

  $("#userSearch").addEventListener("input", (e) => { state.userQuery = e.target.value.trim().toLowerCase(); renderUsers(); });
  $$("#userFilters .chip").forEach((b) => (b.onclick = () => {
    state.userFilter = b.dataset.uf;
    $$("#userFilters .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderUsers();
  }));

  $("#auditSearch").addEventListener("input", (e) => { state.auditQuery = e.target.value.trim().toLowerCase(); renderAudit(); });
  $$("#auditFilters .chip").forEach((b) => (b.onclick = () => {
    state.auditFilter = b.dataset.af;
    $$("#auditFilters .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderAudit();
  }));

  if (!isAdmin) {
    toast("Somente leitura", { text: `O perfil ${UI.session().role} pode consultar, mas não alterar RBAC.`, type: "info", timeout: 6000 });
  }
})();
