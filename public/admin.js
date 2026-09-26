(() => {
  "use strict";

  const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

  const $ = (id) => document.getElementById(id);
  const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const euro = (n) => `${Number(n).toLocaleString("es-ES")} €`;
  const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDay = (s) => fromISO(s).toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  const fmtLongDay = (s) => fromISO(s).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const fmtStamp = (s) => new Date(s).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });

  let services = [];
  let today = null;

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(`/api/admin${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/login") { showLogin(); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || "Algo ha fallado.");
    return data;
  }

  // ---------- Sesión ----------
  function showLogin() {
    $("login-view").hidden = false;
    $("app-view").hidden = true;
    $("logout").hidden = true;
    $("password").focus();
  }

  async function showApp() {
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("logout").hidden = false;
    today = (await fetch("/api/config").then((r) => r.json())).today;
    await loadServices();
    openTab(location.hash.slice(1) || "dashboard");
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    try {
      await api("/login", { method: "POST", body: { password: $("password").value } });
      $("password").value = "";
      showApp();
    } catch (err) {
      $("login-error").textContent = err.message;
    }
  });

  $("logout").addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  // ---------- Pestañas ----------
  const loaders = { dashboard: loadDashboard, bookings: loadBookings, services: renderServices, closures: loadClosures, messages: loadMessages };

  function openTab(name) {
    if (!loaders[name]) name = "dashboard";
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    history.replaceState(null, "", `#${name}`);
    loaders[name]().catch((err) => console.error(err));
  }

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) openTab(b.dataset.tab);
  });

  // ---------- Resumen ----------
  async function loadDashboard() {
    const s = await api("/stats");
    today = s.today;
    setUnread(s.unread);
    $("kpis").innerHTML = [
      ["Próximos 7 días", s.next7.people, `personas · ${s.next7.bookings} reservas`],
      ["Ingresos del mes", euro(s.month.revenue), `${s.month.bookings} reservas`],
      ["Reservas hechas hoy", s.createdToday, ""],
      ["Mensajes sin leer", s.unread, ""],
    ].map(([label, value, sub]) => `<div class="kpi"><span>${label}</span><strong>${value}</strong> <small>${sub}</small></div>`).join("");

    if (!s.departures.length) {
      $("departures").innerHTML = '<p class="empty">No hay salidas con reservas esta semana.</p>';
    } else {
      let html = "", lastDate = "";
      for (const d of s.departures) {
        if (d.date !== lastDate) {
          html += `<p class="day-label">${d.date === s.today ? "Hoy · " : ""}${escapeHTML(fmtLongDay(d.date))}</p>`;
          lastDate = d.date;
        }
        const pct = Math.min(100, Math.round((d.people / d.capacity) * 100));
        html += `<div class="row">
          <strong>${d.time}</strong>
          <span class="grow">${escapeHTML(d.emoji)} ${escapeHTML(d.name)}</span>
          <span class="meter" title="${pct}% ocupado"><i class="${pct >= 75 ? "high" : ""}" style="width:${pct}%"></i></span>
          <span class="num">${d.people}/${d.capacity}</span>
          <a href="#bookings" data-goto="${d.date}|${escapeHTML(d.service)}" class="small">Ver</a>
        </div>`;
      }
      $("departures").innerHTML = html;
    }

    $("by-service").innerHTML = s.byService.map((r) => `<div class="row">
      <span class="grow">${escapeHTML(r.emoji)} ${escapeHTML(r.name)}</span>
      <span class="num muted small">${r.bookings} res. · ${r.people} pers.</span>
      <strong class="num">${euro(r.revenue)}</strong></div>`).join("");
  }

  $("departures").addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto]");
    if (!a) return;
    e.preventDefault();
    const [date, service] = a.dataset.goto.split("|");
    const f = $("booking-filters");
    f.from.value = date; f.to.value = date; f.service.value = service; f.status.value = "confirmed"; f.q.value = "";
    openTab("bookings");
  });

  // ---------- Reservas ----------
  function filterQuery() {
    const f = $("booking-filters");
    const p = new URLSearchParams();
    for (const k of ["from", "to", "service", "status", "q"]) if (f[k].value) p.set(k, f[k].value.trim());
    return p.toString();
  }

  async function loadBookings() {
    const f = $("booking-filters");
    if (!f.dataset.init) {
      f.dataset.init = "1";
      if (!f.from.value && today) f.from.value = today;
    }
    const q = filterQuery();
    $("csv-link").href = `/api/admin/bookings.csv?${q}`;
    const rows = await api(`/bookings?${q}`);
    const confirmed = rows.filter((r) => r.status === "confirmed");
    $("bookings-count").textContent = `${rows.length} reservas · ${confirmed.reduce((n, r) => n + r.people, 0)} personas · ${euro(confirmed.reduce((n, r) => n + r.total, 0))}`;
    $("bookings-body").innerHTML = rows.length ? rows.map((r) => `
      <tr class="${r.status === "cancelled" ? "is-cancelled" : ""}">
        <td>${escapeHTML(fmtDay(r.date))}</td>
        <td>${r.time}</td>
        <td>${escapeHTML(r.service_emoji)} ${escapeHTML(r.service_name)}</td>
        <td class="num">${r.people}</td>
        <td class="num">${euro(r.total)}</td>
        <td>${escapeHTML(r.name)}</td>
        <td><a href="mailto:${escapeHTML(r.email)}">${escapeHTML(r.email)}</a><br /><a href="tel:${escapeHTML(r.phone.replace(/[^\d+]/g, ""))}">${escapeHTML(r.phone)}</a></td>
        <td class="notes">${escapeHTML(r.notes || "")}</td>
        <td><code>${escapeHTML(r.code)}</code></td>
        <td>${r.status === "cancelled" ? '<span class="badge badge-cancelled">Cancelada</span>'
          : `<button class="btn btn-small btn-ghost" data-cancel="${escapeHTML(r.code)}">Cancelar</button>`}</td>
      </tr>`).join("") : '<tr><td colspan="10" class="empty">No hay reservas con estos filtros.</td></tr>';
  }

  let filterTimer;
  $("booking-filters").addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(loadBookings, 250); });
  $("booking-filters").addEventListener("submit", (e) => { e.preventDefault(); loadBookings(); });

  $("bookings-body").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cancel]");
    if (!b || !confirm(`¿Cancelar la reserva ${b.dataset.cancel}? Se liberarán sus plazas.`)) return;
    try {
      await api(`/bookings/${encodeURIComponent(b.dataset.cancel)}/cancel`, { method: "POST" });
      loadBookings();
    } catch (err) { alert(err.message); }
  });

  // ---------- Actividades ----------
  async function loadServices() {
    services = await api("/services");
    const opts = services.map((s) => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.emoji)} ${escapeHTML(s.name)}</option>`).join("");
    const f = $("booking-filters").service;
    const cur = f.value;
    f.innerHTML = `<option value="">Todas</option>${opts}`;
    f.value = cur;
    $("cl-service").innerHTML = `<option value="">Todas</option>${opts}`;
  }

  async function renderServices() {
    await loadServices();
    $("services-list").innerHTML = services.map((s) => `
      <article class="service-card ${s.active ? "" : "inactive"}">
        <div class="service-emoji" aria-hidden="true">${escapeHTML(s.emoji)}</div>
        <h3>${escapeHTML(s.name)} ${s.active ? "" : '<span class="badge">Oculta</span>'}</h3>
        <p>${escapeHTML(s.description)}</p>
        <ul class="service-meta">
          <li>${euro(s.price)}/pers.</li>
          <li>👥 ${s.capacity}</li>
          <li>🕒 ${s.slots.join(" · ")}</li>
          <li>📅 ${DAY_ORDER.filter((d) => s.days.includes(d)).map((d) => DAYS[d]).join(" ")}</li>
          ${s.months ? `<li>${s.months.map((m) => MONTHS[m - 1]).join(", ")}</li>` : ""}
        </ul>
        <div class="service-foot"><span class="muted small">${escapeHTML(s.id)}</span>
          <button class="btn btn-small" data-edit="${escapeHTML(s.id)}">Editar</button></div>
      </article>`).join("");
  }

  const form = $("service-form");
  $("sf-days").innerHTML = DAY_ORDER.map((d) => `<label><input type="checkbox" name="days" value="${d}" /> ${DAYS[d]}</label>`).join("");
  $("sf-months").innerHTML = MONTHS.map((m, i) => `<label><input type="checkbox" name="months" value="${i + 1}" /> ${m}</label>`).join("");

  function openServiceDialog(s) {
    const isNew = !s;
    s = s || { id: "", emoji: "⛰️", name: "", description: "", duration: "", price: 30, capacity: 10, slots: ["10:00"], days: [0, 1, 2, 3, 4, 5, 6], months: null, active: true };
    form.dataset.mode = isNew ? "new" : s.id;
    $("service-dialog-title").textContent = isNew ? "Nueva actividad" : "Editar actividad";
    $("sf-id").value = s.id; $("sf-id").disabled = !isNew;
    $("sf-emoji").value = s.emoji; $("sf-name").value = s.name; $("sf-description").value = s.description;
    $("sf-duration").value = s.duration; $("sf-price").value = s.price; $("sf-capacity").value = s.capacity;
    $("sf-slots").value = s.slots.join(", ");
    form.querySelectorAll('[name="days"]').forEach((c) => { c.checked = s.days.includes(Number(c.value)); });
    form.querySelectorAll('[name="months"]').forEach((c) => { c.checked = !!s.months?.includes(Number(c.value)); });
    $("sf-active").checked = s.active;
    $("service-error").textContent = "";
    $("service-dialog").showModal();
  }

  $("new-service").addEventListener("click", () => openServiceDialog(null));
  $("services-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-edit]");
    if (b) openServiceDialog(services.find((s) => s.id === b.dataset.edit));
  });
  $("service-cancel").addEventListener("click", () => $("service-dialog").close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const checked = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map((c) => Number(c.value));
    const body = {
      id: $("sf-id").value.trim(),
      emoji: $("sf-emoji").value.trim(),
      name: $("sf-name").value.trim(),
      description: $("sf-description").value.trim(),
      duration: $("sf-duration").value.trim(),
      price: Number($("sf-price").value),
      capacity: Number($("sf-capacity").value),
      slots: $("sf-slots").value.split(/[,\s]+/).filter(Boolean).map((t) => (/^\d:\d\d$/.test(t) ? "0" + t : t)),
      days: checked("days"),
      months: checked("months"),
      active: $("sf-active").checked,
    };
    try {
      const mode = form.dataset.mode;
      if (mode === "new") await api("/services", { method: "POST", body });
      else await api(`/services/${encodeURIComponent(mode)}`, { method: "PUT", body });
      $("service-dialog").close();
      renderServices();
    } catch (err) {
      $("service-error").textContent = err.message;
    }
  });

  // ---------- Cierres ----------
  async function loadClosures() {
    await loadServices();
    if (today) $("cl-date").min = today;
    const list = await api("/closures");
    $("closures-list").innerHTML = list.length ? list.map((c) => `<div class="row">
        <strong>${escapeHTML(fmtDay(c.date))}</strong>
        <span class="grow">${escapeHTML(c.service_name || "Todas las actividades")}${c.reason ? ` · <span class="muted">${escapeHTML(c.reason)}</span>` : ""}</span>
        <button class="btn btn-small btn-ghost" data-del-closure="${c.id}">Quitar</button></div>`).join("")
      : '<p class="empty">No hay cierres programados.</p>';
  }

  $("closure-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("closure-status");
    status.className = "form-error";
    status.textContent = "";
    try {
      const r = await api("/closures", { method: "POST", body: { date: $("cl-date").value, service: $("cl-service").value || null, reason: $("cl-reason").value } });
      status.className = "form-ok";
      status.textContent = r.affected
        ? `Cierre añadido. Atención: hay ${r.affected} reserva(s) confirmadas ese día; avisa a los clientes y cancélalas en «Reservas».`
        : "Cierre añadido.";
      $("closure-form").reset();
      loadClosures();
    } catch (err) {
      status.textContent = err.message;
    }
  });

  $("closures-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del-closure]");
    if (!b) return;
    await api(`/closures/${b.dataset.delClosure}`, { method: "DELETE" }).catch((err) => alert(err.message));
    loadClosures();
  });

  // ---------- Mensajes ----------
  function setUnread(n) {
    $("unread-badge").hidden = !n;
    $("unread-badge").textContent = n;
  }

  async function loadMessages() {
    const list = await api("/messages");
    setUnread(list.filter((m) => !m.read).length);
    $("messages-list").innerHTML = list.length ? list.map((m) => `
      <article class="message ${m.read ? "" : "unread"}">
        <header><strong>${escapeHTML(m.name)} · <a href="mailto:${escapeHTML(m.email)}">${escapeHTML(m.email)}</a></strong>
          <span class="muted small">${escapeHTML(fmtStamp(m.created_at))}</span></header>
        <p>${escapeHTML(m.message)}</p>
        <div class="actions">
          <a class="btn btn-small" href="mailto:${escapeHTML(m.email)}?subject=${encodeURIComponent("Vive Alto Campoo")}">Responder</a>
          <button class="btn btn-small btn-ghost" data-read="${m.id}" data-value="${m.read ? 0 : 1}">${m.read ? "Marcar no leído" : "Marcar leído"}</button>
          <button class="btn btn-small btn-ghost" data-del-msg="${m.id}">Borrar</button>
        </div>
      </article>`).join("") : '<p class="empty">No hay mensajes.</p>';
  }

  $("messages-list").addEventListener("click", async (e) => {
    const r = e.target.closest("[data-read]");
    const d = e.target.closest("[data-del-msg]");
    try {
      if (r) await api(`/messages/${r.dataset.read}`, { method: "PATCH", body: { read: r.dataset.value === "1" } });
      else if (d && confirm("¿Borrar este mensaje?")) await api(`/messages/${d.dataset.delMsg}`, { method: "DELETE" });
      else return;
      loadMessages();
    } catch (err) { alert(err.message); }
  });

  // ---------- Inicio ----------
  fetch("/api/admin/me").then((r) => r.json()).then((s) => (s.loggedIn ? showApp() : showLogin())).catch(showLogin);
})();
