/* ============================================================
   UPDOWN NOC — Administração da plataforma (aplicação real)
   Perfis/permissões, telas, usuários e auditoria via /api/platform,
   /api/users e /api/audit. Toda ação continua auditada no backend.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;

  const state = {
    tab: "perfis",
    model: { roles: [], permissions: [], screens: [], rolePermissions: [], roleScreens: [] },
    users: [],
    audit: [],
    role: null,
    userQuery: "", userFilter: "todos",
    auditQuery: "", auditFilter: "todos",
    isAdmin: false,
  };

  const permIdsOf = (roleId) => new Set(state.model.rolePermissions.filter((x) => x.role_id === roleId).map((x) => x.permission_id));
  const screenIdsOf = (roleId) => new Set(state.model.roleScreens.filter((x) => x.role_id === roleId).map((x) => x.screen_id));

  /* ---------------- carregamento ---------------- */
  async function loadModel() {
    state.model = await NOC.api("/api/platform/roles");
    if (!state.role) state.role = state.model.roles[0] || null;
    else state.role = state.model.roles.find((r) => r.id === state.role.id) || state.model.roles[0] || null;
    renderRoles();
    renderRoleEditor();
    renderScreens();
  }
  async function loadUsers() {
    state.users = await NOC.api("/api/users");
    renderUsers();
  }
  async function loadAudit() {
    state.audit = await NOC.api("/api/audit?limit=300");
    renderAudit();
  }

  /* ---------------- perfis ---------------- */
  function renderRoles() {
    $("#roleList").innerHTML = state.model.roles.map((r) => `
      <button class="role-item" type="button" data-role="${r.id}" aria-current="${state.role?.id === r.id}">
        <span class="row-between"><b>${esc(r.name)}</b>
          <span class="badge">${permIdsOf(r.id).size} perm.</span></span>
        <small>${esc(r.description || "Sem descrição.")}</small>
      </button>`).join("");
    $$("#roleList [data-role]").forEach((b) => (b.onclick = () => {
      state.role = state.model.roles.find((r) => r.id === +b.dataset.role);
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
    const perms = permIdsOf(r.id);
    const screens = screenIdsOf(r.id);
    const protegido = r.name === "administrador";
    const bloqueado = protegido || !state.isAdmin;

    host.innerHTML = `
      <div class="card-head">
        <div>
          <span class="kicker">Perfil</span>
          <h2 style="margin-top:6px;text-transform:capitalize">${esc(r.name)}</h2>
          <p>${esc(r.description || "Sem descrição.")}</p>
        </div>
        <div class="row wrap" style="gap:6px;justify-content:flex-end">
          <span class="badge badge-info">${perms.size} permissões</span>
          <span class="badge">${screens.size} telas</span>
          ${protegido ? '<span class="badge badge-ok">perfil protegido</span>' : ""}
        </div>
      </div>
      <div class="card-body stack">
        ${protegido ? `<div class="alert alert-info" style="animation:none">${icon("info")}
          <span>O perfil administrador mantém acesso total por definição do sistema — é a garantia de que sempre existe quem consiga reabrir o acesso.</span></div>` : ""}

        <div class="field">
          <label for="roleDesc">Descrição</label>
          <textarea class="textarea" id="roleDesc" ${state.isAdmin ? "" : "disabled"}>${esc(r.description || "")}</textarea>
        </div>

        <div class="perm-grid">
          <div class="perm-box">
            <h3>Permissões</h3>
            ${state.model.permissions.map((p) => `
              <label class="checkbox">
                <input type="checkbox" data-perm="${p.id}" ${perms.has(p.id) ? "checked" : ""} ${bloqueado ? "disabled" : ""}>
                <span><b class="mono">${esc(p.code)}</b><small>${esc(p.description || "")}</small></span>
              </label>`).join("")}
          </div>
          <div class="perm-box">
            <h3>Telas visíveis</h3>
            ${state.model.screens.map((s) => `
              <label class="checkbox">
                <input type="checkbox" data-screen="${s.id}" ${screens.has(s.id) && s.active ? "checked" : ""} ${!s.active || bloqueado ? "disabled" : ""}>
                <span><b>${esc(s.name)}</b><small>${esc(s.route || "")} — ${esc(s.description || "")}${s.active ? "" : " (tela desativada)"}</small></span>
              </label>`).join("")}
          </div>
        </div>
      </div>
      <div class="card-foot" style="justify-content:space-between">
        <span class="dim" style="font-size:var(--fs-11)">${state.isAdmin ? "Somente o perfil administrador altera RBAC." : "Seu perfil não pode alterar RBAC."}</span>
        <span class="row">
          ${protegido || !state.isAdmin ? "" : `<button class="btn btn-danger btn-sm" id="delRole" type="button">${icon("trash")} Excluir perfil</button>`}
          <button class="btn btn-primary btn-sm" id="saveRole" type="button" ${bloqueado ? "disabled" : ""}>Salvar alterações</button>
        </span>
      </div>`;

    const save = $("#saveRole");
    if (save) save.onclick = async () => {
      save.classList.add("is-loading");
      try {
        const permissionIds = $$("[data-perm]:checked", host).map((x) => +x.dataset.perm);
        const screenIds = $$("[data-screen]:checked", host).map((x) => +x.dataset.screen);
        const description = $("#roleDesc", host).value;
        await NOC.api(`/api/platform/roles/${r.id}/access`, {
          method: "PUT", body: JSON.stringify({ permissionIds, screenIds, description }),
        });
        await NOC.api(`/api/platform/roles/${r.id}`, { method: "PATCH", body: JSON.stringify({ description }) });
        await loadModel();
        toast("Perfil atualizado", { text: `${r.name}: permissões e telas gravadas e auditadas.`, type: "ok" });
      } catch (err) {
        toast("Não foi possível salvar", { text: err.message, type: "danger", timeout: 7000 });
      } finally {
        save.classList.remove("is-loading");
      }
    };

    const del = $("#delRole");
    if (del) del.onclick = () => askConfirm({
      title: `Excluir o perfil ${r.name}?`,
      text: "As contas com este perfil perdem o acesso atual. Reatribua os usuários antes de excluir.",
      confirmLabel: "Excluir perfil",
      danger: true,
      onConfirm: async () => {
        try {
          await NOC.api(`/api/platform/roles/${r.id}`, { method: "DELETE" });
          state.role = null;
          await loadModel();
          toast("Perfil excluído", { text: "Exclusão registrada na auditoria.", type: "warn" });
        } catch (err) {
          toast("Não foi possível excluir", { text: err.message, type: "danger", timeout: 7000 });
        }
      },
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
          <div class="field"><label for="rName">Nome do perfil</label><input class="input" id="rName" placeholder="Ex.: supervisor-noc"></div>
          <div class="field"><label for="rDesc">Descrição</label><textarea class="textarea" id="rDesc" placeholder="O que este perfil pode fazer no dia a dia"></textarea></div>
          <div class="alert alert-info" style="animation:none">${icon("info")}
            <span>O perfil nasce sem nenhuma permissão. Você marca o que ele pode fazer logo depois de criar.</span></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A criação é auditada.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Criar perfil</button></span>
        </div>`,
      onMount: (host, close) => {
        $("[data-go]", host).onclick = async () => {
          const name = $("#rName", host).value.trim();
          if (!name) return $("#rName", host).focus();
          try {
            const novo = await NOC.api("/api/platform/roles", {
              method: "POST", body: JSON.stringify({ name, description: $("#rDesc", host).value.trim() }),
            });
            close();
            state.role = novo;
            await loadModel();
            toast("Perfil criado", { text: "Marque agora as permissões e as telas deste perfil.", type: "ok" });
          } catch (err) {
            toast("Não foi possível criar", { text: err.message, type: "danger", timeout: 7000 });
          }
        };
      },
    });
  }

  /* ---------------- usuários ---------------- */
  function filteredUsers() {
    const q = state.userQuery;
    return state.users.filter((u) => {
      if (state.userFilter === "ativos" && !u.active) return false;
      if (state.userFilter === "inativos" && u.active) return false;
      if (!q) return true;
      return `${u.display_name} ${u.username} ${u.role}`.toLowerCase().includes(q);
    });
  }

  function renderUsers() {
    const list = filteredUsers();
    $("#userCount").textContent = state.users.length;
    $("#userRows").innerHTML = list.length ? list.map((u) => `
      <tr>
        <td>
          <div class="row" style="gap:var(--s-3)">
            <span class="avatar">${esc(UI.initials(u.display_name || u.username))}</span>
            <span><b>${esc(u.display_name || u.username)}</b><br><small class="dim">${esc(u.username)}</small></span>
          </div>
        </td>
        <td>
          <label class="sr-only" for="role-${u.id}">Perfil de ${esc(u.display_name || u.username)}</label>
          <select class="select" id="role-${u.id}" data-user-role="${u.id}" ${state.isAdmin ? "" : "disabled"}>
            ${state.model.roles.map((r) => `<option value="${esc(r.name)}" ${r.name === u.role ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
          </select>
        </td>
        <td><span class="badge ${u.active ? "badge-ok" : "badge-danger"}"><i class="dot ${u.active ? "dot-ok" : "dot-danger"}"></i>${u.active ? "Ativo" : "Inativo"}</span></td>
        <td class="mono dim">${esc(u.last_login_at || "—")}</td>
        <td>
          <div class="row" style="gap:6px;justify-content:flex-end">
            <button class="btn btn-sm" type="button" data-reset="${u.id}" ${state.isAdmin ? "" : "disabled"}>Redefinir senha</button>
            <button class="btn btn-sm ${u.active ? "btn-danger" : ""}" type="button" data-toggle="${u.id}" ${state.isAdmin ? "" : "disabled"}>${u.active ? "Desativar" : "Ativar"}</button>
          </div>
        </td>
      </tr>`).join("") : `<tr><td colspan="5"><div class="empty">
        <span class="empty-icon">${icon("users")}</span><b>Nenhuma conta encontrada</b><p>Ajuste a busca ou o filtro de status.</p></div></td></tr>`;

    $$("[data-user-role]").forEach((sel) => (sel.onchange = async () => {
      const u = state.users.find((x) => x.id === +sel.dataset.userRole);
      const antes = u.role;
      try {
        await NOC.api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role: sel.value }) });
        u.role = sel.value;
        toast(`Perfil de ${u.display_name || u.username} alterado`, {
          text: `${antes} → ${u.role}. Alteração auditada.`,
          type: "ok",
          action: {
            label: "Desfazer",
            run: async () => {
              try {
                await NOC.api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role: antes }) });
                u.role = antes;
                renderUsers();
              } catch (err) { toast("Não foi possível reverter", { text: err.message, type: "danger" }); }
            },
          },
        });
      } catch (err) {
        sel.value = antes;
        toast("Não foi possível alterar o perfil", { text: err.message, type: "danger", timeout: 7000 });
      }
    }));

    $$("[data-toggle]").forEach((b) => (b.onclick = () => {
      const u = state.users.find((x) => x.id === +b.dataset.toggle);
      const aplicar = async (active) => {
        try {
          await NOC.api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active }) });
          u.active = active;
          renderUsers();
          toast(active ? "Conta reativada" : "Conta desativada", { type: active ? "ok" : "warn" });
        } catch (err) {
          toast("Não foi possível alterar a conta", { text: err.message, type: "danger", timeout: 7000 });
        }
      };
      if (u.active) {
        askConfirm({
          title: `Desativar ${u.display_name || u.username}?`,
          text: "A conta perde o acesso imediatamente. O histórico de auditoria é mantido.",
          confirmLabel: "Desativar conta",
          danger: true,
          onConfirm: () => aplicar(false),
        });
      } else aplicar(true);
    }));

    $$("[data-reset]").forEach((b) => (b.onclick = () => {
      const u = state.users.find((x) => x.id === +b.dataset.reset);
      openReset(u);
    }));
  }

  /* A senha é digitada pelo administrador e enviada para a API — o
     protótipo não gera senha no navegador para não dar falsa segurança. */
  function openReset(u) {
    modal({
      labelledBy: "rsTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(u.username)}</span><h2 id="rsTitle" style="margin-top:6px">Redefinir senha</h2>
          <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Defina uma senha temporária e passe ao usuário por um canal seguro.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field"><label for="npass">Nova senha (mínimo 8 caracteres)</label>
            <input class="input" id="npass" type="password" minlength="8" autocomplete="new-password"></div>
          <span class="field-error" id="rsErr" hidden></span>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A redefinição é auditada.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Redefinir senha</button></span>
        </div>`,
      onMount: (host, close) => {
        $("[data-go]", host).onclick = async () => {
          const v = $("#npass", host).value;
          const err = $("#rsErr", host);
          if (v.length < 8) {
            err.hidden = false;
            err.innerHTML = icon("alert") + " A senha precisa ter ao menos 8 caracteres.";
            return;
          }
          try {
            await NOC.api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ password: v }) });
            close();
            toast("Senha redefinida", { text: `${u.username} deve trocar a senha no próximo acesso.`, type: "ok" });
          } catch (e2) {
            err.hidden = false;
            err.innerHTML = icon("alert") + " " + esc(e2.message);
          }
        };
      },
    });
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
            <div class="field grow"><label for="uNome">Nome completo</label><input class="input" id="uNome"></div>
            <div class="field grow"><label for="uUser">Usuário de acesso</label><input class="input" id="uUser" autocomplete="off"></div>
          </div>
          <div class="field"><label for="uPass">Senha inicial (mínimo 8 caracteres)</label>
            <input class="input" id="uPass" type="password" minlength="8" autocomplete="new-password"></div>
          <div class="field"><label for="uRole">Perfil</label>
            <select class="select" id="uRole">${state.model.roles.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join("")}</select>
            <span class="field-hint" id="roleHint"></span>
          </div>
          <span class="field-error" id="nuErr" hidden></span>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Criação auditada.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Criar usuário</button></span>
        </div>`,
      onMount: (host, close) => {
        const sel = $("#uRole", host), hint = $("#roleHint", host);
        const paintHint = () => {
          const r = state.model.roles.find((x) => x.name === sel.value);
          hint.textContent = r ? `${r.description || "Sem descrição."} (${permIdsOf(r.id).size} permissões)` : "";
        };
        sel.onchange = paintHint;
        paintHint();

        $("[data-go]", host).onclick = async () => {
          const err = $("#nuErr", host);
          const payload = {
            display_name: $("#uNome", host).value.trim(),
            username: $("#uUser", host).value.trim(),
            password: $("#uPass", host).value,
            role: sel.value,
          };
          if (!payload.username || !payload.display_name || payload.password.length < 8) {
            err.hidden = false;
            err.innerHTML = icon("alert") + " Preencha nome, usuário e uma senha de ao menos 8 caracteres.";
            return;
          }
          try {
            await NOC.api("/api/users", { method: "POST", body: JSON.stringify(payload) });
            close();
            await loadUsers();
            toast("Usuário criado", { text: `${payload.display_name} recebeu o perfil ${payload.role}.`, type: "ok" });
          } catch (e2) {
            err.hidden = false;
            err.innerHTML = icon("alert") + " " + esc(e2.message);
          }
        };
      },
    });
  }

  /* ---------------- telas ---------------- */
  function renderScreens() {
    $("#screenRows").innerHTML = state.model.screens.map((s) => {
      const perfis = state.model.roles.filter((r) => screenIdsOf(r.id).has(s.id));
      return `<tr>
        <td><b>${esc(s.name)}</b><br><small class="dim mono">${esc(s.code)}</small></td>
        <td class="mono dim">${esc(s.route || "—")}</td>
        <td class="dim">${esc(s.description || "")}</td>
        <td>${perfis.length ? perfis.map((r) => `<span class="badge">${esc(r.name)}</span>`).join(" ") : '<span class="dim">nenhum</span>'}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-screen-toggle="${s.id}" ${s.active ? "checked" : ""} ${state.isAdmin ? "" : "disabled"}>
            <span class="switch-track"></span>
            <span class="sr-only">Ativar a tela ${esc(s.name)}</span>
          </label>
        </td>
      </tr>`;
    }).join("");

    $$("[data-screen-toggle]").forEach((c) => (c.onchange = async () => {
      const s = state.model.screens.find((x) => x.id === +c.dataset.screenToggle);
      try {
        await NOC.api(`/api/platform/screens/${s.id}`, { method: "PUT", body: JSON.stringify({ active: c.checked }) });
        await loadModel();
        toast(`${s.name} ${c.checked ? "ativada" : "desativada"}`, {
          text: c.checked ? "Volta a aparecer para os perfis autorizados." : "Ninguém consegue abrir a tela enquanto estiver desativada.",
          type: c.checked ? "ok" : "warn",
        });
      } catch (err) {
        c.checked = !c.checked;
        toast("Não foi possível alterar a tela", { text: err.message, type: "danger", timeout: 7000 });
      }
    }));
  }

  /* ---------------- auditoria ---------------- */
  function renderAudit() {
    const q = state.auditQuery;
    const grupo = (a) => {
      const acao = String(a.action || "").toLowerCase();
      if (acao.includes("topology")) return "topology";
      if (acao.includes("login") || acao.includes("logout") || acao.includes("password") || acao.includes("auth")) return "auth";
      if (acao.includes("user")) return "user";
      return "outros";
    };
    const list = state.audit.filter((a) => {
      if (state.auditFilter !== "todos" && grupo(a) !== state.auditFilter) return false;
      if (!q) return true;
      return JSON.stringify(a).toLowerCase().includes(q);
    });

    $("#auditCount").textContent = `${list.length} registro${list.length === 1 ? "" : "s"}`;
    $("#auditList").innerHTML = list.length ? list.map((a) => {
      const risco = /delete|denied|failed|remove/i.test(a.action || "");
      const detalhes = [a.details_json, a.before_json, a.after_json].filter(Boolean).length;
      return `<article class="timeline-item ${risco ? "is-danger" : ""}">
        <time>${esc(a.occurred_at || a.created_at || "—")}</time>
        <span class="timeline-rail"><i></i></span>
        <div class="timeline-body">
          <div class="row wrap" style="gap:var(--s-2)">
            <b>${esc(a.username || "sistema")}</b>
            <span class="badge ${risco ? "badge-danger" : "badge-info"}">${esc(a.action)}</span>
          </div>
          <div class="meta">
            <span>${esc(a.resource_type || "")} ${esc(a.resource_id || "")}</span>
            <span class="mono">IP ${esc(a.ip || "—")}</span>
            ${a.path ? `<span class="mono">${esc(a.method || "")} ${esc(a.path)}</span>` : ""}
          </div>
          ${detalhes ? `<details style="margin-top:6px">
            <summary style="cursor:pointer;color:var(--cyan-400);font-size:var(--fs-11)">Ver estado anterior e posterior</summary>
            <pre class="mono" style="margin-top:6px;padding:var(--s-3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2);max-height:280px;overflow:auto;white-space:pre-wrap;font-size:var(--fs-10)">${esc(JSON.stringify({ before: a.before_json, after: a.after_json, details: a.details_json }, null, 2))}</pre>
          </details>` : ""}
        </div>
      </article>`;
    }).join("") : `<div class="empty"><span class="empty-icon">${icon("clock")}</span><b>Nenhum registro</b><p>Nenhuma ação corresponde ao filtro atual.</p></div>`;
  }

  /* ---------------- abas ---------------- */
  function setTab(tab) {
    state.tab = tab;
    $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
    ["perfis", "usuarios", "telas", "auditoria"].forEach((id) => ($("#painel-" + id).hidden = id !== tab));
    if (tab === "auditoria" && !state.audit.length) loadAudit().catch((e) => toast("Falha ao carregar auditoria", { text: e.message, type: "danger" }));
  }

  /* ---------------- início ---------------- */
  async function boot() {
    UI.mountShell({ active: "plataforma" });
    $("#iconSearchUsers").innerHTML = icon("search");
    $("#iconSearchAudit").innerHTML = icon("search");
    $("#btnExport").innerHTML = icon("download") + " Exportar auditoria";
    $("#newRole").innerHTML = icon("plus") + " Criar perfil";
    $("#newUser").innerHTML = icon("plus") + " Novo usuário";

    NOC.skeleton($("#roleList"), 5);
    NOC.skeleton($("#roleEditor"), 6);

    try {
      const me = await NOC.api("/api/auth/me");
      state.isAdmin = me.authenticated && me.user?.role === "administrador";
      await loadModel();
      await loadUsers();
    } catch (err) {
      NOC.errorState($("#roleEditor"), err, () => location.reload());
      toast("Falha ao carregar a plataforma", { text: err.message, type: "danger", timeout: 8000 });
      return;
    }

    $$("[data-tab]").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
    $("#newRole").onclick = openNewRole;
    $("#newUser").onclick = openNewUser;
    $("#newRole").disabled = !state.isAdmin;
    $("#newUser").disabled = !state.isAdmin;

    $("#btnExport").onclick = () => {
      if (!state.audit.length) return toast("Abra a aba Auditoria primeiro", { type: "info" });
      // Exportação local do que já está carregado — nada sai do navegador.
      const linhas = [["data", "usuario", "acao", "recurso", "ip"].join(";")]
        .concat(state.audit.map((a) => [a.occurred_at || a.created_at, a.username, a.action, `${a.resource_type || ""} ${a.resource_id || ""}`.trim(), a.ip || ""]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")));
      const blob = new Blob(["﻿" + linhas.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `auditoria-updown-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Auditoria exportada", { text: `${state.audit.length} registros em CSV.`, type: "ok" });
    };

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

    if (!state.isAdmin) {
      toast("Somente leitura", { text: "Apenas o perfil administrador altera perfis, telas e contas.", type: "info", timeout: 6000 });
    }
  }

  boot();
})();
