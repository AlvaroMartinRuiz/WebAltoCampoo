(() => {
  "use strict";

  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const MY_KEY = "vac_my_bookings_v2";

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (s) => fromISO(s).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const euro = (n) => `${n.toLocaleString("es-ES")} €`;
  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento no disponible */ }
  }

  async function api(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Sin conexión con el servidor. Inténtalo de nuevo.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Algo ha fallado. Inténtalo de nuevo.");
    return data;
  }

  // ---------- Estado ----------
  const state = {
    config: null,
    services: [],
    service: null,
    today: null,
    lastDay: null,
    month: null,
    date: null,
    time: null,
    days: {}, // disponibilidad del mes: { fecha: { closed?, slots: { hora: libres } } }
    loadSeq: 0,
  };

  const svc = () => state.services.find((s) => s.id === state.service);
  const serviceById = (id) => state.services.find((s) => s.id === id);
  const freeSpots = (date, time) => state.days[date]?.slots[time] ?? 0;

  // ---------- Render: actividades ----------
  function renderServices() {
    if (!state.services.length) {
      $("services-grid").innerHTML = '<p class="muted">Ahora mismo no hay actividades disponibles.</p>';
      return;
    }
    $("services-grid").innerHTML = state.services.map((s) => `
      <article class="service-card">
        <div class="service-emoji" aria-hidden="true">${escapeHTML(s.emoji)}</div>
        <h3>${escapeHTML(s.name)}</h3>
        <p>${escapeHTML(s.description)}</p>
        <ul class="service-meta">
          ${s.duration ? `<li>⏱ ${escapeHTML(s.duration)}</li>` : ""}
          <li>👥 máx. ${s.capacity}</li>
          <li>🕒 ${s.slots.join(" · ")}</li>
          ${s.months ? `<li>📅 ${s.months.map((m) => MONTHS[m - 1].slice(0, 3)).join(", ")}</li>` : ""}
        </ul>
        <div class="service-foot">
          <strong>${euro(s.price)}<small>/persona</small></strong>
          <button class="btn btn-small" data-book="${escapeHTML(s.id)}">Reservar</button>
        </div>
      </article>`).join("");

    $("service").innerHTML = state.services.map((s) => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.emoji)} ${escapeHTML(s.name)} — ${euro(s.price)}</option>`).join("");
  }

  // ---------- Render: calendario ----------
  async function loadMonth() {
    const seq = ++state.loadSeq;
    const from = toISO(state.month);
    const to = toISO(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0));
    $("cal-days").classList.add("loading");
    try {
      const av = await api(`/services/${encodeURIComponent(state.service)}/availability?from=${from}&to=${to}`);
      if (seq !== state.loadSeq) return; // llegó una respuesta más nueva
      state.days = av.days;
      $("form-error").textContent = "";
    } catch (err) {
      if (seq !== state.loadSeq) return;
      state.days = {};
      $("form-error").textContent = err.message;
    }
    $("cal-days").classList.remove("loading");
    if (state.date && !state.days[state.date] && state.date.slice(0, 7) === from.slice(0, 7)) state.date = null;
    if (state.time && !(state.date && freeSpots(state.date, state.time) > 0)) state.time = null;
    renderCalendar();
    renderSlots();
    renderSummary();
  }

  function renderCalendar() {
    const y = state.month.getFullYear(), m = state.month.getMonth();
    $("cal-title").textContent = `${MONTHS[m]} ${y}`;
    $("cal-prev").disabled = y === state.today.getFullYear() && m === state.today.getMonth();
    $("cal-next").disabled = new Date(y, m + 1, 1) > state.lastDay;

    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // lunes primero
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayISO = toISO(state.today);
    const capacity = svc().capacity;
    let html = "<span></span>".repeat(offset);

    for (let d = 1; d <= daysInMonth; d++) {
      const iso = toISO(new Date(y, m, d));
      const day = state.days[iso];
      let cls = "day", disabled = true, label = "No disponible";
      if (day?.closed) { cls += " closed"; label = `Cerrado: ${day.closed}`; }
      else if (day) {
        const times = Object.keys(day.slots);
        const free = times.reduce((sum, t) => sum + day.slots[t], 0);
        if (times.length === 0 || free === 0) { cls += " full"; label = "Completo"; }
        else {
          disabled = false;
          cls += free / (times.length * capacity) <= 0.25 ? " low" : " ok";
          label = `${free} plazas libres`;
        }
      }
      if (iso === state.date) cls += " selected";
      if (iso === todayISO) cls += " today";
      html += `<button type="button" class="${cls}" data-date="${iso}" ${disabled ? "disabled" : ""} title="${escapeHTML(label)}" aria-label="${d} de ${MONTHS[m]}: ${escapeHTML(label)}">${d}</button>`;
    }
    $("cal-days").innerHTML = html;
  }

  // ---------- Render: horas ----------
  function renderSlots() {
    const el = $("slots");
    if (!state.date || !state.days[state.date]) { el.innerHTML = '<p class="muted">Elige primero un día.</p>'; return; }
    el.innerHTML = Object.entries(state.days[state.date].slots).map(([t, free]) => {
      const cls = ["slot", free === 0 ? "full" : "", t === state.time ? "selected" : ""].join(" ");
      return `<button type="button" class="${cls}" data-time="${t}" ${free === 0 ? "disabled" : ""}>
        <strong>${t}</strong><span>${free === 0 ? "Completo" : `${free} libres`}</span></button>`;
    }).join("");
  }

  // ---------- Render: resumen ----------
  function renderSummary() {
    const s = svc();
    const people = Math.max(1, parseInt($("people").value, 10) || 1);
    const picked = state.date && state.time;
    $("sum-service").textContent = s.name;
    $("sum-date").textContent = state.date ? fmtDate(state.date) : "—";
    $("sum-time").textContent = state.time || "—";
    $("sum-people").textContent = people;
    $("sum-free").textContent = picked ? freeSpots(state.date, state.time) : "—";
    $("sum-total").textContent = euro(people * s.price);
    $("people").max = picked ? Math.max(1, freeSpots(state.date, state.time)) : s.capacity;
  }

  // ---------- Mis reservas (guardadas en este dispositivo, estado desde el servidor) ----------
  function bookingCard(b, { cancellable }) {
    const cancelled = b.status === "cancelled";
    return `<div class="my-booking ${cancelled ? "is-cancelled" : ""}">
      <span class="service-emoji small" aria-hidden="true">${escapeHTML(b.serviceEmoji ?? "📅")}</span>
      <div><strong>${escapeHTML(b.serviceName ?? b.service)}</strong>
      <p class="muted">${fmtDate(b.date)} · ${b.time} · ${plural(b.people, "persona")} · ${euro(b.total)}</p></div>
      <code>${escapeHTML(b.code)}</code>
      ${cancelled ? '<span class="badge badge-cancelled">Cancelada</span>'
        : cancellable ? `<button class="btn btn-small btn-ghost" data-cancel="${escapeHTML(b.code)}">Cancelar</button>` : ""}
    </div>`;
  }

  async function renderMyBookings() {
    const todayISO = toISO(state.today);
    const saved = readJSON(MY_KEY, []).filter((b) => b.date >= todayISO);
    writeJSON(MY_KEY, saved);
    $("mis-reservas").hidden = saved.length === 0;
    if (!saved.length) return;

    const results = await Promise.all(saved.map((b) =>
      api("/bookings/lookup", { method: "POST", body: { code: b.code, email: b.email } }).then((r) => ({ ...r, email: b.email })).catch(() => null)));
    const list = results.filter(Boolean).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    $("mis-reservas").hidden = list.length === 0;
    $("my-bookings-list").innerHTML = list.map((b) => bookingCard(b, { cancellable: true })).join("");
    $("my-bookings-list").dataset.emails = JSON.stringify(Object.fromEntries(list.map((b) => [b.code, b.email])));
  }

  async function cancelFlow(code, email) {
    if (!confirm(`¿Seguro que quieres cancelar la reserva ${code}?`)) return false;
    try {
      await api("/bookings/cancel", { method: "POST", body: { code, email } });
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    }
  }

  // ---------- Acciones ----------
  function selectService(id) {
    state.service = id;
    state.date = null;
    state.time = null;
    $("service").value = id;
    loadMonth();
  }

  function validate() {
    const people = parseInt($("people").value, 10);
    if (!state.date) return "Elige un día.";
    if (!state.time) return "Elige una hora.";
    if (!people || people < 1) return "Indica el número de personas.";
    if (people > freeSpots(state.date, state.time)) return `Solo quedan ${freeSpots(state.date, state.time)} plazas en ese horario.`;
    if (!$("name").value.trim()) return "Escribe tu nombre.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($("email").value.trim())) return "Escribe un email válido.";
    if ($("phone").value.replace(/\D/g, "").length < 9) return "Escribe un teléfono válido.";
    return "";
  }

  async function submit(e) {
    e.preventDefault();
    const error = validate();
    $("form-error").textContent = error;
    if (error) return;

    const btn = $("submit-btn");
    btn.disabled = true;
    btn.textContent = "Reservando…";
    try {
      const email = $("email").value.trim();
      const booking = await api("/bookings", {
        method: "POST",
        body: {
          service: state.service, date: state.date, time: state.time,
          people: parseInt($("people").value, 10),
          name: $("name").value.trim(), email, phone: $("phone").value.trim(), notes: $("notes").value.trim(),
        },
      });
      const mine = readJSON(MY_KEY, []);
      mine.push({ code: booking.code, email, date: booking.date });
      writeJSON(MY_KEY, mine);

      $("confirm-text").textContent = `${booking.name}, te esperamos el ${fmtDate(booking.date)} a las ${booking.time} para "${booking.serviceName}" (${plural(booking.people, "persona")}, ${euro(booking.total)}).`;
      $("confirm-code").textContent = booking.code;
      $("confirm-dialog").showModal();

      $("booking-form").reset();
      $("service").value = state.service;
      state.time = null;
      await loadMonth();
      renderMyBookings();
    } catch (err) {
      await loadMonth();
      $("form-error").textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirmar reserva";
    }
  }

  async function lookup(e) {
    e.preventDefault();
    const code = $("lookup-code").value.trim().toUpperCase();
    const email = $("lookup-email").value.trim();
    $("lookup-error").textContent = "";
    $("lookup-result").innerHTML = "";
    if (!code || !email) { $("lookup-error").textContent = "Escribe el código y el email."; return; }
    try {
      const b = await api("/bookings/lookup", { method: "POST", body: { code, email } });
      $("lookup-result").innerHTML = bookingCard(b, { cancellable: true });
      $("lookup-result").dataset.email = email;
    } catch (err) {
      $("lookup-error").textContent = err.message;
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    const status = $("contact-status");
    const btn = $("contact-btn");
    status.className = "form-error";
    btn.disabled = true;
    try {
      await api("/messages", {
        method: "POST",
        body: { name: $("c-name").value, email: $("c-email").value, message: $("c-message").value },
      });
      $("contact-form").reset();
      status.className = "form-ok";
      status.textContent = "¡Gracias! Hemos recibido tu mensaje.";
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Eventos ----------
  function bind() {
    $("services-grid").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-book]");
      if (!btn) return;
      selectService(btn.dataset.book);
      $("reservas").scrollIntoView({ behavior: "smooth" });
    });
    $("service").addEventListener("change", (e) => selectService(e.target.value));
    $("cal-prev").addEventListener("click", () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); loadMonth(); });
    $("cal-next").addEventListener("click", () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); loadMonth(); });
    $("cal-days").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-date]");
      if (!btn || btn.disabled) return;
      state.date = btn.dataset.date;
      state.time = null;
      renderCalendar(); renderSlots(); renderSummary();
    });
    $("slots").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-time]");
      if (!btn || btn.disabled) return;
      state.time = btn.dataset.time;
      renderSlots(); renderSummary();
    });
    $("people").addEventListener("input", renderSummary);
    $("booking-form").addEventListener("submit", submit);
    $("lookup-form").addEventListener("submit", lookup);
    $("contact-form").addEventListener("submit", sendMessage);

    $("my-bookings-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-cancel]");
      if (!btn) return;
      const emails = JSON.parse($("my-bookings-list").dataset.emails || "{}");
      if (await cancelFlow(btn.dataset.cancel, emails[btn.dataset.cancel])) { renderMyBookings(); loadMonth(); }
    });
    $("lookup-result").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-cancel]");
      if (!btn) return;
      if (await cancelFlow(btn.dataset.cancel, $("lookup-result").dataset.email)) {
        $("lookup-form").requestSubmit();
        renderMyBookings();
        loadMonth();
      }
    });

    // Refresca la disponibilidad al volver a la pestaña: otras personas pueden haber reservado.
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.service) loadMonth(); });
  }

  async function init() {
    bind();
    try {
      const [config, services] = await Promise.all([api("/config"), api("/services")]);
      state.config = config;
      state.services = services;
      state.today = fromISO(config.today);
      state.lastDay = fromISO(config.today);
      state.lastDay.setDate(state.lastDay.getDate() + config.windowDays);
      state.month = new Date(state.today.getFullYear(), state.today.getMonth(), 1);
      $("cancel-hours").textContent = config.cancelHours;
    } catch (err) {
      $("services-grid").innerHTML = `<p class="form-error">${escapeHTML(err.message)}</p>`;
      $("form-error").textContent = err.message;
      return;
    }
    renderServices();
    if (!state.services.length) { $("reservas").hidden = true; return; }
    state.service = state.services[0].id;
    $("service").value = state.service;
    renderMyBookings();
    loadMonth();
  }

  init();
})();
