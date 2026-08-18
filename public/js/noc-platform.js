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
    model: { roles: [], permissions: [], screens: [], sectors: [], rolePermissions: [], roleScreens: [], can: {}, protectedRole: "administrador" },
    users: [],
    audit: [],
    role: null,
    roleQuery: "",
    dirty: false,
    userQuery: "", userFilter: "todos",
    auditQuery: "", auditFilter: "todos",
  };

  const can = (acao) => !!state.model.can?.[acao];
  const ehProtegido = (r) => r?.name === state.model.protectedRole;
  const permIdsOf = (roleId) => new Set(state.model.rolePermissions.filter((x) => x.role_id === roleId).map((x) => x.permission_id));
  const screenIdsOf = (roleId) => new Set(state.model.roleScreens.filter((x) => x.role_id === roleId).map((x) => x.screen_id));

  /* Ações agrupadas na mesma ordem do catálogo do Worker: cada módulo do
     sistema vira um bloco, então nenhuma funcionalidade fica de fora da tela. */
  function modulos() {
    const grupos = new Map();
    state.model.permissions.forEach((p) => {
      const chave = p.module || "Geral";
      if (!grupos.has(chave)) grupos.set(chave, { nome: chave, screen_code: p.screen_code, acoes: [] });
      grupos.get(chave).acoes.push(p);
    });
    return [...grupos.values()];
  }

  /* ---------------- carregamento ---------------- */
  async function loadModel() {
    state.model = await NOC.api("/api/platform/roles");
    state.dirty = false;
    if (!state.role) state.role = state.model.roles[0] || null;
    else state.role = state.model.roles.find((r) => r.id === state.role.id) || state.model.roles[0] || null;
    renderRoles();
    renderRoleEditor();
    renderScreens();
    renderSectors();
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
    const q = state.roleQuery;
    const lista = state.model.roles.filter((r) => !q || `${r.name} ${r.description || ""}`.toLowerCase().includes(q));

    $("#roleList").innerHTML = lista.length ? lista.map((r) => `
      <button class="role-item" type="button" data-role="${r.id}" aria-current="${state.role?.id === r.id}">
        <span class="row-between"><b>${esc(r.name)}</b>
          <span class="row" style="gap:4px">
            <span class="badge">${permIdsOf(r.id).size} ações</span>
            <span class="badge">${screenIdsOf(r.id).size} telas</span>
          </span></span>
        <small>${esc(r.description || "Sem descrição.")}</small>
        <small class="dim">${r.usuarios || 0} usuário${Number(r.usuarios) === 1 ? "" : "s"}${ehProtegido(r) ? " • perfil protegido" : ""}</small>
      </button>`).join("")
      : `<div class="empty" style="padding:var(--s-4)"><b>Nenhum perfil encontrado</b><p>Ajuste a busca.</p></div>`;

    $$("#roleList [data-role]").forEach((b) => (b.onclick = () => {
      const ir = () => {
        state.role = state.model.roles.find((r) => r.id === +b.dataset.role);
        state.dirty = false;
        renderRoles();
        renderRoleEditor();
      };
      if (!state.dirty) return ir();
      askConfirm({
        title: "Descartar as alterações?",
        text: `As mudanças no perfil ${state.role?.name} ainda não foram salvas.`,
        confirmLabel: "Descartar e trocar de perfil",
        danger: true,
        onConfirm: ir,
      });
    }));
  }

  function renderRoleEditor() {
    const r = state.role;
    const host = $("#roleEditor");
    if (!r) {
      host.innerHTML = `<div class="empty"><span class="empty-icon">${icon("shield")}</span><b>Selecione um perfil</b><p>As ações e as telas aparecem aqui.</p></div>`;
      return;
    }
    const perms = permIdsOf(r.id);
    const screens = screenIdsOf(r.id);
    const protegido = ehProtegido(r);
    const editavel = can("manageRoles");
    // O administrador continua com acesso total: só o texto do perfil muda.
    const acessoBloqueado = protegido || !editavel;

    const telaPorCodigo = Object.fromEntries(state.model.screens.map((s) => [s.code, s]));

    const blocoAcoes = (m) => {
      const tela = telaPorCodigo[m.screen_code];
      const marcadas = m.acoes.filter((p) => perms.has(p.id)).length;
      return `
        <div class="perm-box" data-modulo="${esc(m.nome)}">
          <div class="row-between" style="gap:var(--s-2);padding-bottom:var(--s-3);border-bottom:1px solid var(--line);margin-bottom:var(--s-2)">
            <span>
              <b style="font-size:var(--fs-13)">${esc(m.nome)}</b>
              <small class="dim" style="display:block;font-size:var(--fs-11)">
                ${tela ? `Tela ${esc(tela.name)}` : "Sistema"} • <span data-conta>${marcadas}</span>/${m.acoes.length} ações
              </small>
            </span>
            ${acessoBloqueado ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-todas>Marcar todas</button>`}
          </div>
          ${m.acoes.map((p) => `
            <label class="checkbox">
              <input type="checkbox" data-perm="${p.id}" ${perms.has(p.id) ? "checked" : ""} ${acessoBloqueado ? "disabled" : ""}>
              <span><b>${esc(p.name || p.code)}</b><small>${esc(p.description || "")}<br><span class="mono dim">${esc(p.code)}</span></small></span>
            </label>`).join("")}
        </div>`;
    };

    host.innerHTML = `
      <div class="card-head">
        <div>
          <span class="kicker">Perfil</span>
          <h2 style="margin-top:6px;text-transform:capitalize">${esc(r.name)}</h2>
          <p>${esc(r.description || "Sem descrição.")}</p>
        </div>
        <div class="row wrap" style="gap:6px;justify-content:flex-end">
          <span class="badge badge-info" id="contaAcoes">${perms.size} ações</span>
          <span class="badge" id="contaTelas">${screens.size} telas</span>
          <span class="badge">${r.usuarios || 0} usuário${Number(r.usuarios) === 1 ? "" : "s"}</span>
          ${protegido ? '<span class="badge badge-ok">perfil protegido</span>' : ""}
        </div>
      </div>
      <div class="card-body stack">
        ${protegido ? `<div class="alert alert-info" style="animation:none">${icon("info")}
          <span>O perfil administrador mantém acesso total por definição do sistema — é a garantia de que sempre existe quem consiga reabrir o acesso. O nome e a descrição continuam editáveis.</span></div>` : ""}
        ${editavel ? "" : `<div class="alert alert-info" style="animation:none">${icon("info")}
          <span>Seu perfil pode consultar, mas não alterar, a configuração de acesso. É preciso a ação <b class="mono">roles.manage</b>.</span></div>`}

        <div class="row wrap" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow" style="min-width:220px">
            <label for="roleName">Nome do perfil</label>
            <input class="input" id="roleName" value="${esc(r.name)}" ${!editavel || protegido ? "disabled" : ""}>
            <span class="field-hint">${protegido ? "O perfil administrador não pode ser renomeado." : "Letras minúsculas, números, hífen e sublinhado."}</span>
          </div>
          <div class="field grow" style="min-width:260px">
            <label for="roleDesc">Descrição</label>
            <textarea class="textarea" id="roleDesc" ${editavel ? "" : "disabled"}>${esc(r.description || "")}</textarea>
          </div>
        </div>

        <div class="perm-box">
          <div class="row-between" style="gap:var(--s-2);padding-bottom:var(--s-3);border-bottom:1px solid var(--line);margin-bottom:var(--s-2)">
            <span>
              <b style="font-size:var(--fs-13)">Telas do sistema</b>
              <small class="dim" style="display:block;font-size:var(--fs-11)">O que este perfil consegue abrir no menu.</small>
            </span>
            ${acessoBloqueado ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-todas-telas>Marcar todas</button>`}
          </div>
          <div class="perm-grid" style="gap:var(--s-2)">
            ${state.model.screens.map((s) => `
              <label class="checkbox">
                <input type="checkbox" data-screen="${s.id}" ${screens.has(s.id) ? "checked" : ""} ${!s.active || acessoBloqueado ? "disabled" : ""}>
                <span><b>${esc(s.name)}</b><small><span class="mono">${esc(s.route || "")}</span> — ${esc(s.description || "")}${s.active ? "" : " (tela desativada)"}</small></span>
              </label>`).join("")}
          </div>
        </div>

        <div>
          <h3 style="font-size:var(--fs-13);margin-bottom:var(--s-2)">Funcionalidades</h3>
          <p class="dim" style="font-size:var(--fs-11);margin-bottom:var(--s-3)">
            Cada funcionalidade do sistema é uma ação declarada aqui. A tela diz onde o perfil entra; a ação diz o que ele faz lá dentro.
          </p>
          <div class="perm-grid">${modulos().map(blocoAcoes).join("")}</div>
        </div>
      </div>
      <div class="card-foot" style="justify-content:space-between">
        <span class="dim" style="font-size:var(--fs-11)" id="roleDirty">Toda alteração de perfil é auditada.</span>
        <span class="row">
          ${editavel ? `<button class="btn btn-sm" id="dupRole" type="button">${icon("plus")} Duplicar</button>` : ""}
          ${protegido || !editavel ? "" : `<button class="btn btn-danger btn-sm" id="delRole" type="button">${icon("trash")} Excluir perfil</button>`}
          <button class="btn btn-primary btn-sm" id="saveRole" type="button" ${editavel ? "" : "disabled"}>Salvar alterações</button>
        </span>
      </div>`;

    /* Contadores acompanham a marcação, para o administrador enxergar o
       tamanho do acesso antes de gravar. */
    const atualizarResumo = () => {
      $("#contaAcoes", host).textContent = `${$$("[data-perm]:checked", host).length} ações`;
      $("#contaTelas", host).textContent = `${$$("[data-screen]:checked", host).length} telas`;
      $$("[data-modulo]", host).forEach((box) => {
        const conta = $("[data-conta]", box);
        if (conta) conta.textContent = $$("[data-perm]:checked", box).length;
      });
    };

    const marcarSujo = () => {
      state.dirty = true;
      $("#roleDirty", host).innerHTML = "<b>Alterações não salvas.</b>";
    };

    // #roleEditor sobrevive ao innerHTML: sem remover o anterior, cada
    // re-render empilharia mais um ouvinte no mesmo elemento.
    if (host._onChange) host.removeEventListener("change", host._onChange);
    host._onChange = (e) => {
      if (!e.target.matches("[data-perm],[data-screen]")) return;
      atualizarResumo();
      marcarSujo();
    };
    host.addEventListener("change", host._onChange);
    ["#roleName", "#roleDesc"].forEach((sel) => {
      const el = $(sel, host);
      if (el) el.addEventListener("input", marcarSujo);
    });

    $$("[data-todas]", host).forEach((b) => (b.onclick = () => {
      const box = b.closest("[data-modulo]");
      const caixas = $$("[data-perm]:not(:disabled)", box);
      const marcar = caixas.some((c) => !c.checked);
      caixas.forEach((c) => (c.checked = marcar));
      b.textContent = marcar ? "Desmarcar todas" : "Marcar todas";
      atualizarResumo();
      marcarSujo();
    }));

    const todasTelas = $("[data-todas-telas]", host);
    if (todasTelas) todasTelas.onclick = () => {
      const caixas = $$("[data-screen]:not(:disabled)", host);
      const marcar = caixas.some((c) => !c.checked);
      caixas.forEach((c) => (c.checked = marcar));
      todasTelas.textContent = marcar ? "Desmarcar todas" : "Marcar todas";
      atualizarResumo();
      marcarSujo();
    };

    const save = $("#saveRole");
    if (save) save.onclick = async () => {
      save.classList.add("is-loading");
      try {
        const nome = $("#roleName", host).value.trim();
        const description = $("#roleDesc", host).value;
        if (!protegido && nome !== r.name) {
          await NOC.api(`/api/platform/roles/${r.id}`, { method: "PATCH", body: JSON.stringify({ name: nome, description }) });
        } else {
          await NOC.api(`/api/platform/roles/${r.id}`, { method: "PATCH", body: JSON.stringify({ description }) });
        }
        await NOC.api(`/api/platform/roles/${r.id}/access`, {
          method: "PUT",
          body: JSON.stringify({
            permissionIds: $$("[data-perm]:checked", host).map((x) => +x.dataset.perm),
            screenIds: $$("[data-screen]:checked", host).map((x) => +x.dataset.screen),
          }),
        });
        state.dirty = false;
        await loadModel();
        toast("Perfil atualizado", { text: `${nome || r.name}: ações e telas gravadas e auditadas.`, type: "ok" });
      } catch (err) {
        toast("Não foi possível salvar", { text: err.message, type: "danger", timeout: 7000 });
      } finally {
        save.classList.remove("is-loading");
      }
    };

    const dup = $("#dupRole");
    if (dup) dup.onclick = () => duplicarPerfil(r, host);

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
          state.dirty = false;
          await loadModel();
          toast("Perfil excluído", { text: "Exclusão registrada na auditoria.", type: "warn" });
        } catch (err) {
          toast("Não foi possível excluir", { text: err.message, type: "danger", timeout: 7000 });
        }
      },
    });
  }

  /* Duplicar copia o que está marcado na tela: é assim que se cria uma
     variação de um perfil sem remarcar dezenas de ações uma a uma. */
  function duplicarPerfil(r, host) {
    modal({
      labelledBy: "dupTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(r.name)}</span><h2 id="dupTitle" style="margin-top:6px">Duplicar perfil</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field"><label for="dupName">Nome do novo perfil</label>
            <input class="input" id="dupName" value="${esc(r.name)}-copia"></div>
          <span class="field-hint">As ações e as telas marcadas agora na tela são copiadas para o novo perfil.</span>
          <span class="field-error" id="dupErr" hidden></span>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A criação é auditada.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Duplicar</button></span>
        </div>`,
      onMount: (m, close) => {
        $("[data-go]", m).onclick = async () => {
          const err = $("#dupErr", m);
          const name = $("#dupName", m).value.trim();
          try {
            const novo = await NOC.api("/api/platform/roles", {
              method: "POST",
              body: JSON.stringify({ name, description: r.description || "" }),
            });
            await NOC.api(`/api/platform/roles/${novo.id}/access`, {
              method: "PUT",
              body: JSON.stringify({
                permissionIds: $$("[data-perm]:checked", host).map((x) => +x.dataset.perm),
                screenIds: $$("[data-screen]:checked", host).map((x) => +x.dataset.screen),
              }),
            });
            close();
            state.role = novo;
            state.dirty = false;
            await loadModel();
            toast("Perfil duplicado", { text: `${novo.name} nasceu com o mesmo acesso de ${r.name}.`, type: "ok" });
          } catch (e2) {
            err.hidden = false;
            err.innerHTML = icon("alert") + " " + esc(e2.message);
          }
        };
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
      return `${u.display_name} ${u.username} ${u.email || ""} ${u.role}`.toLowerCase().includes(q);
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
            <span><b>${esc(u.display_name || u.username)}</b><br><small class="dim">${esc(u.username)}${u.email ? " · " + esc(u.email) : ""}</small></span>
          </div>
        </td>
        <td>
          <label class="sr-only" for="role-${u.id}">Perfil de ${esc(u.display_name || u.username)}</label>
          <select class="select" id="role-${u.id}" data-user-role="${u.id}" ${can("manageUsers") ? "" : "disabled"}>
            ${state.model.roles.map((r) => `<option value="${esc(r.name)}" ${r.name === u.role ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
          </select>
        </td>
        <td><button class="btn btn-sm" type="button" data-sectors="${u.id}" ${can("manageUsers") ? "" : "disabled"}>${(u.sectors || []).length ? (u.sectors || []).map((s) => esc(s.name)).join(", ") : "Sem setor"}</button></td>
        <td><span class="badge ${u.active ? "badge-ok" : "badge-danger"}"><i class="dot ${u.active ? "dot-ok" : "dot-danger"}"></i>${u.active ? "Ativo" : "Inativo"}</span></td>
        <td class="mono dim">${esc(u.last_login_at || "—")}</td>
        <td>
          <div class="row" style="gap:6px;justify-content:flex-end">
            <button class="btn btn-sm" type="button" data-email="${u.id}" ${can("manageUsers") ? "" : "disabled"}>E-mail OAuth</button>
            <button class="btn btn-sm" type="button" data-reset="${u.id}" ${can("resetPassword") ? "" : "disabled"}>Redefinir senha</button>
            <button class="btn btn-sm ${u.active ? "btn-danger" : ""}" type="button" data-toggle="${u.id}" ${can("manageUsers") ? "" : "disabled"}>${u.active ? "Desativar" : "Ativar"}</button>
          </div>
        </td>
      </tr>`).join("") : `<tr><td colspan="6"><div class="empty">
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

    $$("[data-email]").forEach((b) => (b.onclick = () => {
      const u = state.users.find((x) => x.id === +b.dataset.email);
      openOAuthEmail(u);
    }));
    $$("[data-sectors]").forEach((b) => (b.onclick = () => openUserSectors(state.users.find((x) => x.id === +b.dataset.sectors))));
  }

  function openUserSectors(u) {
    const selected = new Set((u.sectors || []).map((s) => s.id));
    modal({
      labelledBy: "usTitle",
      html: `<div class="modal-head"><div><span class="kicker">Permissões por setor</span><h2 id="usTitle">Setores de ${esc(u.display_name || u.username)}</h2></div><button class="btn btn-ghost btn-icon" data-close>${icon("close")}</button></div>
        <div class="modal-body stack"><p class="muted">O usuário poderá consultar e cadastrar compromissos nas agendas marcadas.</p>${(state.model.sectors || []).filter((s) => s.active).map((s) => `<label class="check-row"><input type="checkbox" data-user-sector="${s.id}" ${selected.has(s.id) ? "checked" : ""}><i class="dot" style="background:${esc(s.color)}"></i><span><b>${esc(s.name)}</b><small>${esc(s.description || "Agenda do setor")}</small></span></label>`).join("") || '<div class="empty"><b>Nenhum setor cadastrado</b><p>Crie um setor na aba Setores.</p></div>'}</div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-save>Salvar setores</button></span></div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          try {
            const sector_ids = $$('[data-user-sector]:checked', host).map((x) => +x.dataset.userSector);
            const updated = await NOC.api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ sector_ids }) });
            u.sectors = updated.sectors || [];
            close(); renderUsers(); toast("Setores atualizados", { type: "ok" });
          } catch (err) { toast("Não foi possível atualizar", { text: err.message, type: "danger" }); }
        };
      },
    });
  }

  function openOAuthEmail(u) {
    modal({
      labelledBy: "oeTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(u.username)}</span><h2 id="oeTitle" style="margin-top:6px">E-mail corporativo</h2>
          <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Deve ser igual ao e-mail verificado enviado pelo provedor OAuth/OIDC.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field"><label for="oauthEmail">E-mail</label>
            <input class="input" id="oauthEmail" type="email" value="${esc(u.email || "")}" autocomplete="off"></div>
          <span class="field-error" id="oeErr" hidden></span>
        </div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Salvar</button></span></div>`,
      onMount: (host, close) => {
        $("[data-go]", host).onclick = async () => {
          const email = $("#oauthEmail", host).value.trim();
          const err = $("#oeErr", host);
          try {
            const updated = await NOC.api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ email }) });
            u.email = updated.email;
            close();
            renderUsers();
            toast("E-mail corporativo atualizado", { type: "ok" });
          } catch (e2) {
            err.hidden = false;
            err.innerHTML = icon("alert") + " " + esc(e2.message);
          }
        };
      },
    });
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
          <div class="field"><label for="uEmail">E-mail corporativo</label>
            <input class="input" id="uEmail" type="email" autocomplete="off" placeholder="usuario@empresa.com.br">
            <span class="field-hint">Usado para vincular a identidade OAuth/OIDC verificada.</span></div>
          <div class="field"><label for="uPass">Senha inicial (mínimo 8 caracteres)</label>
            <input class="input" id="uPass" type="password" minlength="8" autocomplete="new-password"></div>
          <div class="field"><label for="uRole">Perfil</label>
            <select class="select" id="uRole">${state.model.roles.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join("")}</select>
            <span class="field-hint" id="roleHint"></span>
          </div>
          <div class="field"><label>Setores</label><div class="stack" style="gap:6px">${(state.model.sectors || []).filter((s) => s.active).map((s) => `<label class="check-row"><input type="checkbox" data-new-user-sector="${s.id}"><i class="dot" style="background:${esc(s.color)}"></i><span><b>${esc(s.name)}</b></span></label>`).join("") || '<span class="field-hint">Nenhum setor cadastrado ainda.</span>'}</div></div>
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
            email: $("#uEmail", host).value.trim(),
            password: $("#uPass", host).value,
            role: sel.value,
            sector_ids: $$('[data-new-user-sector]:checked', host).map((x) => +x.dataset.newUserSector),
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

  /* ---------------- setores ---------------- */
  function renderSectors() {
    const rows = state.model.sectors || [], host = $("#sectorRows");
    if (!host) return;
    host.innerHTML = rows.length ? rows.map((s) => {
      const menus = state.model.screens.filter((screen) => Number(screen.sector_id) === Number(s.id));
      return `<tr>
        <td><span class="row" style="gap:8px"><span style="color:${esc(s.color)}">${icon(s.icon || "circle")}</span><b>${esc(s.name)}</b></span></td>
        <td class="mono dim">${esc(s.code)}</td>
        <td class="dim">${esc(s.description || "—")}</td>
        <td><span class="badge">${menus.length}</span></td>
        <td><span class="badge">${Number(s.users || 0)}</span></td>
        <td><span class="badge ${s.active ? "badge-ok" : "badge-danger"}">${s.active ? "Ativo" : "Inativo"}</span></td>
        <td><button class="btn btn-sm" type="button" data-edit-sector="${s.id}" ${can("manageSectors") ? "" : "disabled"}>${icon("edit")} Editar</button></td>
      </tr>`;
    }).join("") : '<tr><td colspan="7"><div class="empty"><b>Nenhum setor cadastrado</b><p>Crie o primeiro setor para liberar sua agenda.</p></div></td></tr>';
    $$('[data-edit-sector]',host).forEach((button) => {
      button.onclick = () => openSectorEditor(rows.find((sector) => sector.id === Number(button.dataset.editSector)));
    });
  }

  function openSectorEditor(sector = null) {
    const editing = Boolean(sector);
    const selectedScreens = new Set(editing
      ? state.model.screens.filter((screen) => Number(screen.sector_id) === Number(sector.id)).map((screen) => Number(screen.id))
      : []);
    const iconOptions = [
      ["user","Atendimento"],["users","Equipe"],["pops","Localização"],["dashboard","Indicadores"],
      ["bell","SAC"],["finance","Financeiro"],["topology","Rede"],["calendar","Agenda"],
      ["platform","Administração"],["circle","Padrão"]
    ];
    modal({
      labelledBy: "nsTitle",
      wide: true,
      html: `<div class="modal-head"><div><span class="kicker">Menu, agenda e permissões</span><h2 id="nsTitle">${editing ? `Editar ${esc(sector.name)}` : "Novo setor"}</h2></div><button class="btn btn-ghost btn-icon" data-close>${icon("close")}</button></div>
        <div class="modal-body stack">
          <div class="grid-2">
            <div class="field"><label for="sectorName">Nome</label><input class="input" id="sectorName" value="${esc(sector?.name || "")}" placeholder="Ex.: NOC"></div>
            <div class="field"><label for="sectorCode">Código</label><input class="input mono" id="sectorCode" value="${esc(sector?.code || "")}" placeholder="Gerado pelo nome" ${editing ? "disabled" : ""}><span class="field-hint">Identificador interno; não muda depois da criação.</span></div>
          </div>
          <div class="field"><label for="sectorDescription">Descrição</label><textarea class="textarea" id="sectorDescription" rows="2">${esc(sector?.description || "")}</textarea></div>
          <div class="grid-2">
            <div class="field"><label for="sectorColor">Cor do setor e da agenda</label><input id="sectorColor" type="color" value="${esc(sector?.color || "#2563eb")}"></div>
            <div class="field"><label for="sectorIcon">Ícone</label><select class="select" id="sectorIcon">${iconOptions.map(([value,label]) => `<option value="${value}" ${value === (sector?.icon || "circle") ? "selected" : ""}>${label}</option>`).join("")}</select></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="sectorSort">Ordem no menu</label><input class="input" id="sectorSort" type="number" min="0" max="9999" value="${Number(sector?.sort || 0)}"></div>
            <div class="row-between" style="align-self:end;min-height:42px"><div><b>Setor ativo</b><p class="dim" style="font-size:var(--fs-11)">Visível no menu e na agenda.</p></div><label class="switch"><input type="checkbox" id="sectorActive" ${sector?.active !== 0 ? "checked" : ""} ${sector?.code === "noc" ? "disabled" : ""}><span class="switch-track"></span><span class="sr-only">Setor ativo</span></label></div>
          </div>
          <fieldset><legend>Menus deste setor</legend><div class="permission-list">${state.model.screens.filter((screen) => screen.nav !== 0).map((screen) => `<label class="check-row"><input type="checkbox" data-sector-screen="${screen.id}" ${selectedScreens.has(Number(screen.id)) ? "checked" : ""}><span>${icon(screen.icon || "circle")}<b>${esc(screen.name)}</b><small>${esc(screen.route)}</small></span></label>`).join("")}</div></fieldset>
          <div class="alert alert-danger" data-sector-error hidden></div>
        </div>
        <div class="modal-foot"><span class="dim">A alteração é registrada na auditoria.</span><span class="row"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-save>${editing ? "Salvar alterações" : "Criar setor"}</button></span></div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          const error = $("[data-sector-error]",host);
          const payload = {
            name: $("#sectorName",host).value.trim(),
            description: $("#sectorDescription",host).value.trim(),
            color: $("#sectorColor",host)?.value || sector?.color || "#2563eb",
            icon: $("#sectorIcon",host).value,
            sort: Number($("#sectorSort",host).value),
            active: $("#sectorActive",host).checked,
            screen_ids: $$('[data-sector-screen]:checked',host).map((screen) => Number(screen.dataset.sectorScreen))
          };
          if (!editing) payload.code = $("#sectorCode",host).value.trim();
          if (!payload.name) {
            error.hidden = false; error.textContent = "Informe o nome do setor."; return;
          }
          try {
            await NOC.api(editing ? `/api/platform/sectors/${sector.id}` : "/api/platform/sectors", {
              method: editing ? "PATCH" : "POST", body: JSON.stringify(payload)
            });
            close(); await loadModel(); toast(editing ? "Setor atualizado" : "Setor criado", {
              text: "O menu lateral e a agenda já usam esta configuração.", type: "ok"
            });
          } catch (err) {
            error.hidden = false; error.innerHTML = icon("alert") + " " + esc(err.message);
          }
        };
      },
    });
  }

  function openNewSector() { openSectorEditor(); }

  /* ---------------- telas ---------------- */
  function renderScreens() {
    $("#screenRows").innerHTML = state.model.screens.map((s) => {
      const perfis = state.model.roles.filter((r) => screenIdsOf(r.id).has(s.id));
      const acoes = state.model.permissions.filter((p) => p.screen_code === s.code);
      return `<tr>
        <td><b>${esc(s.name)}</b><br><small class="dim mono">${esc(s.code)}</small></td>
        <td class="mono dim">${esc(s.route || "—")}</td>
        <td class="dim">${esc(s.description || "")}</td>
        <td><span class="badge">${acoes.length} ações</span></td>
        <td>${perfis.length ? perfis.map((r) => `<span class="badge">${esc(r.name)}</span>`).join(" ") : '<span class="dim">nenhum</span>'}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-screen-toggle="${s.id}" ${s.active ? "checked" : ""} ${can("manageScreens") && s.code !== "platform" ? "" : "disabled"}>
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
    ["perfis", "usuarios", "setores", "telas", "auditoria"].forEach((id) => ($("#painel-" + id).hidden = id !== tab));
    if (tab === "auditoria" && !state.audit.length && can("viewAudit")) {
      loadAudit().catch((e) => toast("Falha ao carregar auditoria", { text: e.message, type: "danger" }));
    }
  }

  /* ---------------- início ---------------- */
  async function boot() {
    UI.mountShell({ active: "plataforma" });
    $("#iconSearchUsers").innerHTML = icon("search");
    $("#iconSearchAudit").innerHTML = icon("search");
    $("#btnExport").innerHTML = icon("download") + " Exportar auditoria";
    $("#newRole").innerHTML = icon("plus") + " Criar perfil";
    $("#newUser").innerHTML = icon("plus") + " Novo usuário";
    $("#newSector").innerHTML = icon("plus") + " Novo setor";

    NOC.skeleton($("#roleList"), 5);
    NOC.skeleton($("#roleEditor"), 6);

    try {
      await loadModel();
      if (can("viewUsers")) await loadUsers();
      else $("#userRows").innerHTML = `<tr><td colspan="5"><div class="empty">
        <span class="empty-icon">${icon("users")}</span><b>Sem acesso às contas</b>
        <p>Seu perfil não tem a ação <span class="mono">users.view</span>.</p></div></td></tr>`;
      if (!can("viewAudit")) $("#auditList").innerHTML = `<div class="empty">
        <span class="empty-icon">${icon("clock")}</span><b>Sem acesso à auditoria</b>
        <p>Seu perfil não tem a ação <span class="mono">audit.view</span>.</p></div>`;
    } catch (err) {
      NOC.errorState($("#roleEditor"), err, () => location.reload());
      toast("Falha ao carregar a plataforma", { text: err.message, type: "danger", timeout: 8000 });
      return;
    }

    $$("[data-tab]").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
    $("#newRole").onclick = openNewRole;
    $("#newUser").onclick = openNewUser;
    $("#newSector").onclick = openNewSector;
    $("#newRole").disabled = !can("manageRoles");
    $("#newUser").disabled = !can("manageUsers");
    $("#newSector").disabled = !can("manageSectors");
    $("#btnExport").disabled = !can("exportAudit");
    $("#roleSearch").addEventListener("input", (e) => {
      state.roleQuery = e.target.value.trim().toLowerCase();
      renderRoles();
    });

    // Aviso antes de perder a marcação de ações ao sair da página.
    addEventListener("beforeunload", (e) => {
      if (!state.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    });

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

    if (!can("manageRoles")) {
      toast("Perfis em modo leitura", {
        text: "Alterar perfis exige a ação roles.manage. As demais abas seguem o que o seu perfil permite.",
        type: "info", timeout: 6000,
      });
    }
  }

  boot();
})();
