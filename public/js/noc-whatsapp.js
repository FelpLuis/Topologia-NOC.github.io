(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm, session, initials } = UI;

  const state = {
    data: null,            // resposta do /api/whatsapp
    sector: "",            // filtro de setor
    status: "open",        // filtro: open | routing | closed
    activeId: null,        // conversa aberta no painel
    conversation: null,    // detalhe da conversa aberta
    messages: [],
    can: { chat: false, supervise: false, manage: false },
    lastMessageCount: 0,
    sending: false,
    timer: null
  };

  const PHONE_RE = /^(\d{2})(\d{2})?(\d{5})?(\d{4})?$/;
  const formatPhone = p => {
    const d = String(p || "").replace(/\D/g, "");
    const m = d.match(/^(\d{2})(\d{2})(\d{5})(\d{4})$/);
    if (m) return `+${m[1]} (${m[2]}) ${m[3]}-${m[4]}`;
    return d || "—";
  };
  const formatTime = t => t ? new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  const timeLabel = t => {
    if (!t) return "";
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return formatTime(t);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + formatTime(t);
  };
  const sectorOf = id => (state.data?.sectors || []).find(s => String(s.id) === String(id));
  const convOf = id => (state.data?.conversations || []).find(c => String(c.id) === String(id));
  const mine = c => c && Number(c.assigned_user_id) === Number(window.UPDOWN_AUTH?.id);
  const visibleConv = c => {
    if (state.status === "routing") return c.status === "routing";
    if (state.status === "closed") return c.status === "closed";
    return c.status === "open";
  };

  /* ---------- carregamento ---------- */

  async function load(silent = false) {
    try {
      const data = await NOC.api("/api/whatsapp");
      state.data = data;
      state.can = data.can || state.can;
      if (!state.sector && data.sectors?.length) state.sector = String(data.sectors[0].id);
      if (state.sector && !data.sectors.some(s => String(s.id) === state.sector)) state.sector = "";
      renderFilters();
      renderConvList();
      renderPresence();
      // se a conversa aberta sumiu do filtro atual, fecha o painel
      if (state.activeId && !(data.conversations || []).some(c => String(c.id) === String(state.activeId) && visibleConv(c))) {
        closePane(true);
      } else if (state.activeId && state.conversation) {
        const fresh = (data.conversations || []).find(c => String(c.id) === String(state.activeId));
        if (fresh) updateHead(fresh);
      }
      if (!silent) $("#newChatBtn").disabled = !state.can.chat;
    } catch (err) {
      if (!silent) NOC.errorState($("#convList"), err, () => boot());
    }
  }

  async function loadConversation(id) {
    try {
      const detail = await NOC.api(`/api/whatsapp/conversations/${id}`);
      state.activeId = id;
      state.conversation = detail.conversation;
      state.messages = detail.messages || [];
      state.lastMessageCount = state.messages.length;
      renderChat();
      renderConvList();
      renderPresence();
      if (state.conversation.status === "open" && state.conversation.unread > 0) load(true);
    } catch (err) {
      toast("Não foi possível abrir a conversa", { text: err.message, type: "danger" });
    }
  }

  /* ---------- renderização ---------- */

  function renderFilters() {
    const sectors = state.data?.sectors || [];
    $("#sectorFilter").innerHTML = '<option value="">Todos os setores</option>' +
      sectors.map(s => `<option value="${s.id}" ${state.sector === String(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  }

  function renderConvList() {
    const host = $("#convList");
    const conversations = (state.data?.conversations || []).filter(visibleConv);
    const filtered = conversations.filter(c =>
      (!state.sector || String(c.sector_id) === state.sector) &&
      (state.status !== "open" || c.status === "open") &&
      (state.status !== "routing" || c.status === "routing") &&
      (state.status !== "closed" || c.status === "closed")
    );
    if (!filtered.length) {
      host.innerHTML = `<div class="wa-list-empty"><span class="empty-icon">${icon("users")}</span><b>Nenhuma conversa aqui</b><p>${state.status === "routing" ? "Novos contatos aguardando a escolha de setor aparecem nesta fila." : state.status === "closed" ? "As conversas encerradas aparecem aqui." : "As conversas em atendimento aparecem aqui."}</p></div>`;
      return;
    }
    host.innerHTML = filtered.map(c => {
      const unread = Number(c.unread || 0);
      const name = c.customer_name && c.customer_name !== c.phone ? c.customer_name : c.phone;
      const badge = c.status === "routing" ? `<span class="wa-list-badge routing">Setor</span>` :
        (c.assigned_name ? `<span class="wa-list-badge" style="--wa-badge:${esc(c.sector_color || "var(--cyan-400)")}">${esc(c.assigned_name)}</span>` : "");
      return `<button class="wa-conv-item ${state.activeId === String(c.id) ? "is-active" : ""} ${unread ? "has-unread" : ""}" data-conv="${c.id}" type="button">
        <span class="wa-conv-avatar">${initials(c.customer_name && c.customer_name !== c.phone ? c.customer_name : (c.phone || "?"))}</span>
        <span class="wa-conv-main">
          <span class="wa-conv-top"><b>${esc(name)}</b><small>${esc(timeLabel(c.last_message_at || c.created_at))}</small></span>
          <span class="wa-conv-bottom"><span class="wa-conv-last">${esc(c.last_message || "Sem mensagens")}</span><span class="wa-conv-meta">${badge}${unread ? `<b class="wa-unread">${unread}</b>` : ""}</span></span>
        </span>
      </button>`;
    }).join("");
    $$("[data-conv]").forEach(item => item.onclick = () => {
      state.activeId = item.dataset.conv;
      loadConversation(Number(item.dataset.conv));
    });
  }

  function renderPresence() {
    const list = (state.data?.presence || []).filter(p => !state.sector || p.sectors.includes(Number(state.sector)));
    const self = (state.data?.presence || []).find(p => Number(p.user_id) === Number(window.UPDOWN_AUTH?.id));
    $("#presenceToggle").innerHTML = self?.status === "chat"
      ? `${icon("clock")} Em atendimento`
      : self?.available === false
        ? `${icon("eyeOff")} Retomar disponibilidade`
        : `${icon("eye")} Ficar disponível`;
    $("#presenceToggle").classList.toggle("is-off", self?.available === false);
    const item = p => {
      const label = p.busy
        ? (state.can.supervise && p.current ? `Em conversa com ${esc(p.current.customer_name && p.current.customer_name !== p.current.phone ? p.current.customer_name : formatPhone(p.current.phone))}` : "Em conversa")
        : (p.available === false ? "Pausado" : "Disponível");
      return `<div class="wa-presence-item ${p.busy ? "is-busy" : ""} ${p.available === false ? "is-paused" : ""}" ${state.can.supervise && p.current ? `data-conv="${p.current.conversation_id}"` : ""}>
        <span class="wa-presence-dot"></span>
        <span class="wa-presence-who"><b>${esc(p.display_name)}</b><small>${label}</small></span>
      </div>`;
    };
    $("#presenceList").innerHTML = list.length
      ? list.map(item).join("")
      : '<p class="dim" style="padding:var(--s-3);text-align:center;font-size:var(--fs-12)">Nenhum atendente no setor selecionado.</p>';
    if (state.can.supervise) {
      $$(".wa-presence-item[data-conv]").forEach(el => el.onclick = () => {
        state.activeId = el.dataset.conv;
        loadConversation(Number(el.dataset.conv));
      });
    }
  }

  function updateHead(conv) {
    state.conversation = { ...(state.conversation || {}), ...conv };
    const name = conv.customer_name && conv.customer_name !== conv.phone ? conv.customer_name : formatPhone(conv.phone);
    $("#chatName").textContent = name;
    $("#chatAvatar").textContent = initials(name);
    const parts = [];
    parts.push(conv.status === "routing" ? "Aguardando escolha de setor" : conv.status === "closed" ? "Encerrada" : conv.assigned_name ? `Atendente: ${conv.assigned_name}` : "Aguardando atendente");
    if (conv.sector_name) parts.push(conv.sector_name);
    parts.push(formatPhone(conv.phone));
    $("#chatMeta").textContent = parts.join(" · ");
    renderHeadButtons(conv);
  }

  function renderHeadButtons(conv) {
    const take = $("#takeBtn"), assign = $("#assignBtn"), close = $("#closeBtn");
    const isMine = mine(conv);
    const closed = conv.status === "closed";
    const routing = conv.status === "routing";
    take.hidden = closed || isMine || !state.can.chat;
    take.innerHTML = icon("plus") + (routing ? " Pegar para o setor" : " Pegar");
    assign.hidden = closed || !state.can.supervise;
    assign.innerHTML = icon("edit") + " Atribuir";
    close.hidden = !state.can.chat || (closed);
    close.innerHTML = icon("check") + (isMine || conv.status === "routing" ? " Encerrar" : " Encerrar");
    const canRespond = !closed && !routing && state.can.chat && (isMine || state.can.supervise);
    $("#composer").hidden = !canRespond;
    $("#composer").dataset.ready = canRespond ? "1" : "0";
  }

  function renderMessages() {
    const host = $("#messages");
    const messages = state.messages || [];
    host.innerHTML = messages.length ? messages.map(m => {
      const isIn = m.direction === "in";
      const isBot = m.direction === "bot";
      const statusLabel = m.direction === "out" && m.status ? { sent: "enviada", delivered: "entregue", read: "lida", failed: "falhou" }[m.status] || "" : "";
      return `<div class="wa-msg ${isIn ? "is-in" : isBot ? "is-bot" : "is-out"}">
        <div class="wa-bubble">${esc(m.body)}<span class="wa-msg-meta"><small>${esc(m.direction === "out" ? "Você" : isBot ? "Sistema" : "")}</small><small>${esc(formatTime(m.created_at))}</small>${m.direction === "out" && statusLabel ? `<small class="wa-msg-status">${statusLabel}</small>` : ""}</span></div>
      </div>`;
    }).join("") : '<p class="dim" style="text-align:center;padding:var(--s-8)">Nenhuma mensagem nesta conversa ainda.</p>';
    host.scrollTop = host.scrollHeight;
  }

  function renderChat() {
    const conv = state.conversation;
    if (!conv) { closePane(true); return; }
    $("#chatEmpty").hidden = true;
    $("#chatThread").hidden = false;
    updateHead(conv);
    renderMessages();
    const input = $("#msgInput");
    if ($("#composer").dataset.ready === "1") setTimeout(() => input.focus(), 30);
  }

  function closePane(silent = false) {
    state.activeId = null;
    state.conversation = null;
    state.messages = [];
    state.lastMessageCount = 0;
    $("#chatEmpty").hidden = false;
    $("#chatThread").hidden = true;
    if (!silent) renderConvList();
  }

  /* ---------- ações ---------- */

  function enabledSectors() {
    const codes = state.data?.settings?.routedSectors || [];
    return (state.data?.sectors || []).filter(s => codes.includes(s.code));
  }

  async function sendMessage() {
    const input = $("#msgInput");
    const text = input.value.trim();
    if (!text || state.sending || !state.activeId) return;
    state.sending = true;
    const sendBtn = $("#sendBtn");
    sendBtn.disabled = true;
    try {
      await NOC.api(`/api/whatsapp/conversations/${state.activeId}/messages`, { method: "POST", body: JSON.stringify({ body: text }) });
      input.value = "";
      input.style.height = "auto";
      state.messages.push({ direction: "out", body: text, status: "sent", created_at: new Date().toISOString(), sender_name: "Você" });
      state.lastMessageCount = state.messages.length;
      renderMessages();
      load(true);
      toast("Mensagem enviada", { type: "ok" });
    } catch (err) {
      toast("Não foi possível enviar", { text: err.message, type: "danger" });
    } finally {
      state.sending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  async function takeConversation(conv) {
    if (conv.status === "routing") {
      const options = state.data?.sectors || [];
      const usable = options.filter(s => (state.data?.conversations || []).some() ? true : true);
      if (options.length > 1) {
        modal({
          labelledBy: "waTakeTitle",
          html: `
            <div class="modal-head"><div><span class="kicker">Fila de roteamento</span><h2 id="waTakeTitle">Pegar conversa para o setor</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
            <div class="modal-body"><div class="field"><label for="takeSector">Setor do atendimento</label><select class="select" id="takeSector">${options.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><span class="field-hint">A conversa entra na fila do setor escolhido e você assume o atendimento.</span></div></div>
            <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-take type="button">Pegar conversa</button></span></div>`,
          onMount: (host, close) => {
            $("[data-take]", host).onclick = async () => {
              try {
                await NOC.api(`/api/whatsapp/conversations/${conv.id}/take`, { method: "POST", body: JSON.stringify({ sector_id: Number($("#takeSector", host).value) }) });
                close();
                toast("Conversa atribuída a você", { type: "ok" });
                await load(); await loadConversation(conv.id);
              } catch (err) { toast("Não foi possível pegar", { text: err.message, type: "danger" }); }
            };
          }
        });
        return;
      }
      try {
        await NOC.api(`/api/whatsapp/conversations/${conv.id}/take`, { method: "POST", body: JSON.stringify({ sector_id: options[0]?.id }) });
        toast("Conversa atribuída a você", { type: "ok" });
        await load(); await loadConversation(conv.id);
      } catch (err) { toast("Não foi possível pegar", { text: err.message, type: "danger" }); }
      return;
    }
    try {
      await NOC.api(`/api/whatsapp/conversations/${conv.id}/take`, { method: "POST" });
      toast("Conversa atribuída a você", { type: "ok" });
      await load(); await loadConversation(conv.id);
    } catch (err) { toast("Não foi possível pegar", { text: err.message, type: "danger" }); }
  }

  function assignConversation(conv) {
    const sectors = state.data?.sectors || [];
    const presence = state.data?.presence || [];
    modal({
      wide: true,
      labelledBy: "waAssignTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Supervisão</span><h2 id="waAssignTitle">Atribuir conversa</h2><p class="dim">${esc(conv.customer_name && conv.customer_name !== conv.phone ? conv.customer_name : formatPhone(conv.phone))}</p></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body"><div class="row wrap">
          <div class="field" style="flex:1;min-width:220px"><label for="assignSector">Setor</label><select class="select" id="assignSector">${sectors.map(s => `<option value="${s.id}" ${String(s.id) === String(conv.sector_id || "") ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
          <div class="field" style="flex:1;min-width:220px"><label for="assignUser">Responsável</label><select class="select" id="assignUser"><option value="">Sem responsável (fila)</option></select></div>
        </div><span class="field-error" id="assignError" hidden></span></div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Atribuir</button></span></div>`,
      onMount: (host, close) => {
        const sector = $("#assignSector", host), user = $("#assignUser", host);
        const choices = () => {
          const sid = Number(sector.value);
          const members = [...new Map(presence.filter(p => p.sectors.includes(sid)).map(p => [p.user_id, p])).values()];
          user.innerHTML = '<option value="">Sem responsável (fila)</option>' + members.map(m => `<option value="${m.user_id}" ${String(m.user_id) === String(conv.assigned_user_id || "") ? "selected" : ""}>${esc(m.display_name)}</option>`).join("");
        };
        choices();
        sector.onchange = choices;
        $("[data-save]", host).onclick = async () => {
          const payload = { sector_id: Number(sector.value) };
          if (user.value) payload.user_id = Number(user.value);
          try {
            await NOC.api(`/api/whatsapp/conversations/${conv.id}/assign`, { method: "POST", body: JSON.stringify(payload) });
            close(); toast("Conversa atribuída", { type: "ok" }); await load();
            if (state.activeId === String(conv.id)) await loadConversation(conv.id);
          } catch (err) {
            const error = $("#assignError", host);
            error.hidden = false; error.textContent = err.message;
          }
        };
      }
    });
  }

  async function closeConversation(conv) {
    askConfirm({
      title: "Encerrar esta conversa?",
      text: `O atendimento com ${conv.customer_name && conv.customer_name !== conv.phone ? conv.customer_name : formatPhone(conv.phone)} será encerrado e você voltará a ficar disponível.`,
      confirmLabel: "Encerrar",
      danger: true,
      onConfirm: async () => {
        try {
          await NOC.api(`/api/whatsapp/conversations/${conv.id}/close`, { method: "POST" });
          toast("Conversa encerrada", { type: "ok" });
          closePane(); await load(); renderPresence();
        } catch (err) { toast("Não foi possível encerrar", { text: err.message, type: "danger" }); }
      }
    });
  }

  async function togglePresence() {
    const self = (state.data?.presence || []).find(p => Number(p.user_id) === Number(window.UPDOWN_AUTH?.id));
    const next = self?.busy ? !self.available : !(self?.available ?? true);
    try {
      await NOC.api("/api/whatsapp/presence", { method: "POST", body: JSON.stringify({ available: next }) });
      toast(next ? "Você está disponível" : "Você pausou o atendimento", { type: "ok" });
      await load();
    } catch (err) { toast("Não foi possível atualizar", { text: err.message, type: "danger" }); }
  }

  function newChat() {
    const sectors = state.data?.sectors || [];
    modal({
      wide: true,
      labelledBy: "waNewTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Novo atendimento</span><h2 id="waNewTitle">Iniciar conversa pelo WhatsApp</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body"><div class="crm-form-grid">
          <div class="field span-2"><label for="newPhone">Número do WhatsApp</label><input class="input" id="newPhone" inputmode="tel" placeholder="5511999999999 (DDI + DDD + número)"></div>
          <div class="field"><label for="newName">Nome do cliente</label><input class="input" id="newName" maxlength="200"></div>
          <div class="field"><label for="newSector">Setor</label><select class="select" id="newSector">${sectors.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div>
          <div class="field span-2"><label for="newBody">Primeira mensagem</label><textarea class="textarea" id="newBody" rows="3">Olá! Aqui é a UPDOWN Telecom.</textarea></div>
          <span class="field-error span-2" id="newError" hidden></span>
        </div></div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Iniciar</button></span></div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          const error = $("#newError", host);
          const payload = {
            phone: $("#newPhone", host).value.trim(),
            customer_name: $("#newName", host).value.trim(),
            sector_id: Number($("#newSector", host).value),
            body: $("#newBody", host).value.trim()
          };
          if (!payload.phone || !payload.body) { error.hidden = false; error.textContent = "Informe o número e a primeira mensagem."; return; }
          try {
            const saved = await NOC.api("/api/whatsapp/conversations", { method: "POST", body: JSON.stringify(payload) });
            close(); toast("Conversa iniciada", { type: "ok" });
            await load();
            state.activeId = String(saved.id);
            await loadConversation(saved.id);
          } catch (err) { error.hidden = false; error.textContent = err.message; }
        };
      }
    });
  }

  function settings() {
    const data = state.data;
    if (!data?.settings) return;
    const s = data.settings;
    const options = enabledSectors();
    modal({
      wide: true,
      labelledBy: "waSettingsTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Bot de setor</span><h2 id="waSettingsTitle">Configurar o chat</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body"><div class="crm-form-grid">
          <div class="field span-2"><label for="setGreeting">Saudação do bot</label><textarea class="textarea" id="setGreeting" rows="3">${esc(s.greeting || "")}</textarea></div>
          <div class="field span-2"><label for="setRouted">Setores disponíveis no menu</label>
            <div class="wa-check-grid">${(state.data?.sectors || []).map(x => `<label class="wa-check"><input type="checkbox" value="${esc(x.code)}" ${options.some(o => o.code === x.code) ? "checked" : ""}>${esc(x.name)}</label>`).join("")}</div>
          </div>
          <div class="field span-2"><label for="setRoutingDone">Confirmação de roteamento</label><textarea class="textarea" id="setRoutingDone" rows="2">${esc(s.routingDone || "")}</textarea><span class="field-hint">Use {setor} para inserir o nome do setor escolhido.</span></div>
          <div class="field span-2"><label for="setRoutingError">Resposta quando a opção não é reconhecida</label><textarea class="textarea" id="setRoutingError" rows="2">${esc(s.routingError || "")}</textarea></div>
          <div class="field span-2"><label for="setClosed">Mensagem de conversa encerrada</label><textarea class="textarea" id="setClosed" rows="2">${esc(s.closedMessage || "")}</textarea></div>
          <span class="field-error span-2" id="setError" hidden></span>
        </div></div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Salvar</button></span></div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          const routedSectors = $$("input[type=checkbox]:checked", host).map(cb => cb.value);
          const payload = {
            greeting: $("#setGreeting", host).value.trim(),
            routingDone: $("#setRoutingDone", host).value.trim(),
            routingError: $("#setRoutingError", host).value.trim(),
            closedMessage: $("#setClosed", host).value.trim(),
            routedSectors
          };
          try {
            await NOC.api("/api/whatsapp/settings", { method: "PUT", body: JSON.stringify(payload) });
            close(); toast("Configurações salvas", { type: "ok" }); await load();
          } catch (err) {
            const error = $("#setError", host);
            error.hidden = false; error.textContent = err.message;
          }
        };
      }
    });
  }

  /* ---------- polling ---------- */

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(async () => {
      await load(true);
      if (state.activeId && state.conversation && state.conversation.status !== "closed") {
        try {
          const detail = await NOC.api(`/api/whatsapp/conversations/${state.activeId}`);
          state.conversation = detail.conversation;
          state.messages = detail.messages || [];
          updateHead(detail.conversation);
          if (state.messages.length !== state.lastMessageCount) {
            state.lastMessageCount = state.messages.length;
            renderMessages();
          } else if (state.conversation.unread > 0) {
            renderMessages();
          }
        } catch { /* mantém o estado atual */ }
      }
    }, 5000);
  }

  /* ---------- boot ---------- */

  async function boot() {
    UI.mountShell();
    $("#newChatBtn").innerHTML = icon("plus") + " Novo contato";
    $("#settingsBtn").innerHTML = icon("edit");
    $("#refreshBtn").innerHTML = icon("refresh");
    $("#chatEmptyIcon").innerHTML = icon("users");
    $("#sendBtn").innerHTML = icon("arrowRight");

    $("#refreshBtn").onclick = () => load();
    $("#newChatBtn").onclick = () => newChat();
    $("#settingsBtn").onclick = () => settings();
    $("#presenceToggle").onclick = () => togglePresence();
    $("#sectorFilter").onchange = e => { state.sector = e.target.value; renderConvList(); renderPresence(); };
    $$("[data-status]").forEach(btn => btn.onclick = () => {
      state.status = btn.dataset.status;
      $$("[data-status]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
      renderConvList();
    });
    $("#takeBtn").onclick = () => state.conversation && takeConversation(state.conversation);
    $("#assignBtn").onclick = () => state.conversation && assignConversation(state.conversation);
    $("#closeBtn").onclick = () => state.conversation && closeConversation(state.conversation);
    $("#composer").onsubmit = e => { e.preventDefault(); sendMessage(); };
    const input = $("#msgInput");
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    });

    try {
      await NOC.loadAccess();
      NOC.applyActions();
      await load();
      startPolling();
    } catch (err) {
      NOC.errorState($("#convList"), err, () => boot());
    }
  }

  boot();
})();