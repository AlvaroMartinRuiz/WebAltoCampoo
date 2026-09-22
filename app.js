(() => {
  "use strict";

  const CFG = window.VAC_CONFIG;
  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const MY_KEY = "vac_my_bookings";

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (s) => fromISO(s).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const euro = (n) => `${n.toLocaleString("es-ES")} €`;
  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const newCode = () => "VAC-" + Math.random().toString(36).slice(2, 8).toUpperCase();

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento no disponible */ }
  }

  // ---------- Almacenamiento ----------
  // Ambos adaptadores exponen:
  //   occupancy(serviceId, fromISO, toISO) -> { "YYYY-MM-DD|HH:MM": personas }
  //   create(booking) -> booking guardada (lanza Error si no hay plazas)

  const localStore = {
    KEY: "vac_bookings",
    all() { return readJSON(this.KEY, []); },
    async occupancy(serviceId, from, to) {
      const map = {};
      for (const b of this.all()) {
        if (b.service === serviceId && b.date >= from && b.date <= to) {
          const k = `${b.date}|${b.time}`;
          map[k] = (map[k] || 0) + b.people;
        }
      }
      return map;
    },
    async create(b) {
      const svc = serviceById(b.service);
      const occ = await this.occupancy(b.service, b.date, b.date);
      if ((occ[`${b.date}|${b.time}`] || 0) + b.people > svc.capacity) throw new Error("No quedan plazas suficientes en ese horario.");
      const list = this.all();
      list.push(b);
      writeJSON(this.KEY, list);
      return b;
    },
  };

  const supabaseStore = (url, key) => {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    return {
      async occupancy(serviceId, from, to) {
        const q = `service=eq.${encodeURIComponent(serviceId)}&date=gte.${from}&date=lte.${to}`;
        const res = await fetch(`${url}/rest/v1/slot_occupancy?select=date,time,people&${q}`, { headers });
        if (!res.ok) throw new Error("No se pudo consultar la disponibilidad.");
        const map = {};
        for (const r of await res.json()) map[`${r.date}|${r.time}`] = r.people;
        return map;
      },
      async create(b) {
        const res = await fetch(`${url}/rest/v1/rpc/create_booking`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            p_code: b.code, p_service: b.service, p_date: b.date, p_time: b.time, p_people: b.people,
            p_name: b.name, p_email: b.email, p_phone: b.phone, p_notes: b.notes,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message?.includes("plazas") ? err.message : "No se pudo guardar la reserva. Inténtalo de nuevo.");
        }
        return b;
      },
    };
  };

  const store = CFG.supabase?.url && CFG.supabase?.anonKey
    ? supabaseStore(CFG.supabase.url.replace(/\/$/, ""), CFG.supabase.anonKey)
    : localStore;

  // ---------- Estado ----------
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lastDay = new Date(today); lastDay.setDate(lastDay.getDate() + CFG.bookingWindowDays);

  const state = {
    service: CFG.services[0].id,
    month: new Date(today.getFullYear(), today.getMonth(), 1),
    date: null,
    time: null,
    occ: {},
  };

  function serviceById(id) { return CFG.services.find((s) => s.id === id); }
  const svc = () => serviceById(state.service);

  function runsOn(service, date) {
    if (!service.days.includes(date.getDay())) return false;
    if (service.months && !service.months.includes(date.getMonth() + 1)) return false;
    return date >= today && date <= lastDay;
  }

  function freeSpots(date, time) {
    return svc().capacity - (state.occ[`${date}|${time}`] || 0);
  }

  function slotsFor(dateISO) {
    let slots = svc().slots;
    if (dateISO === toISO(today)) {
      const now = new Date();
      const nowHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      slots = slots.filter((t) => t > nowHM);
    }
    return slots;
  }

  // ---------- Render: actividades ----------
  function renderServices() {
    $("services-grid").innerHTML = CFG.services.map((s) => `
      <article class="service-card">
        <div class="service-emoji" aria-hidden="true">${s.emoji}</div>
        <h3>${escapeHTML(s.name)}</h3>
        <p>${escapeHTML(s.description)}</p>
        <ul class="service-meta">
          <li>⏱ ${escapeHTML(s.duration)}</li>
          <li>👥 máx. ${s.capacity}</li>
          <li>🕒 ${s.slots.join(" · ")}</li>
        </ul>
        <div class="service-foot">
          <strong>${euro(s.price)}<small>/persona</small></strong>
          <button class="btn btn-small" data-book="${s.id}">Reservar</button>
        </div>
      </article>`).join("");

    $("service").innerHTML = CFG.services.map((s) => `<option value="${s.id}">${s.emoji} ${escapeHTML(s.name)} — ${euro(s.price)}</option>`).join("");

    $("services-grid").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-book]");
      if (!btn) return;
      selectService(btn.dataset.book);
      $("reservas").scrollIntoView({ behavior: "smooth" });
    });
  }

  // ---------- Render: calendario ----------
  async function loadMonth() {
    const from = toISO(state.month);
    const to = toISO(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0));
    try {
      state.occ = await store.occupancy(state.service, from, to);
      $("form-error").textContent = "";
    } catch (err) {
      state.occ = {};
      $("form-error").textContent = err.message;
    }
    renderCalendar();
    renderSlots();
    renderSummary();
  }

  function renderCalendar() {
    const y = state.month.getFullYear(), m = state.month.getMonth();
    $("cal-title").textContent = `${MONTHS[m]} ${y}`;
    $("cal-prev").disabled = y === today.getFullYear() && m === today.getMonth();
    $("cal-next").disabled = new Date(y, m + 1, 1) > lastDay;

    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // lunes primero
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let html = "<span></span>".repeat(offset);

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m, d);
      const iso = toISO(date);
      let cls = "day", disabled = true, label = "No disponible";
      if (runsOn(svc(), date)) {
        const slots = slotsFor(iso);
        const free = slots.reduce((sum, t) => sum + Math.max(0, freeSpots(iso, t)), 0);
        const total = slots.length * svc().capacity;
        if (slots.length === 0 || free === 0) { cls += " full"; label = "Completo"; }
        else {
          disabled = false;
          cls += free / total <= 0.25 ? " low" : " ok";
          label = `${free} plazas libres`;
        }
      }
      if (iso === state.date) cls += " selected";
      if (iso === toISO(today)) cls += " today";
      html += `<button type="button" class="${cls}" data-date="${iso}" ${disabled ? "disabled" : ""} title="${label}" aria-label="${d} de ${MONTHS[m]}: ${label}">${d}</button>`;
    }
    $("cal-days").innerHTML = html;
  }

  // ---------- Render: horas ----------
  function renderSlots() {
    const el = $("slots");
    if (!state.date) { el.innerHTML = '<p class="muted">Elige primero un día.</p>'; return; }
    el.innerHTML = slotsFor(state.date).map((t) => {
      const free = Math.max(0, freeSpots(state.date, t));
      const cls = ["slot", free === 0 ? "full" : "", t === state.time ? "selected" : ""].join(" ");
      return `<button type="button" class="${cls}" data-time="${t}" ${free === 0 ? "disabled" : ""}>
        <strong>${t}</strong><span>${free === 0 ? "Completo" : `${free} libres`}</span></button>`;
    }).join("");
  }

  // ---------- Render: resumen ----------
  function renderSummary() {
    const s = svc();
    const people = Math.max(1, parseInt($("people").value, 10) || 1);
    $("sum-service").textContent = s.name;
    $("sum-date").textContent = state.date ? fmtDate(state.date) : "—";
    $("sum-time").textContent = state.time || "—";
    $("sum-people").textContent = people;
    $("sum-free").textContent = state.date && state.time ? freeSpots(state.date, state.time) : "—";
    $("sum-total").textContent = euro(people * s.price);
    $("people").max = state.date && state.time ? Math.max(1, freeSpots(state.date, state.time)) : s.capacity;
  }

  // ---------- Mis reservas ----------
  function renderMyBookings() {
    const list = readJSON(MY_KEY, []).filter((b) => b.date >= toISO(today)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    $("mis-reservas").hidden = list.length === 0;
    $("my-bookings-list").innerHTML = list.map((b) => {
      const s = serviceById(b.service);
      return `<div class="my-booking">
        <span class="service-emoji small" aria-hidden="true">${s?.emoji ?? "📅"}</span>
        <div><strong>${escapeHTML(s?.name ?? b.service)}</strong>
        <p class="muted">${fmtDate(b.date)} · ${b.time} · ${b.people} persona${b.people > 1 ? "s" : ""}</p></div>
        <code>${b.code}</code></div>`;
    }).join("");
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

    const booking = {
      code: newCode(),
      service: state.service,
      date: state.date,
      time: state.time,
      people: parseInt($("people").value, 10),
      name: $("name").value.trim(),
      email: $("email").value.trim(),
      phone: $("phone").value.trim(),
      notes: $("notes").value.trim(),
      createdAt: new Date().toISOString(),
    };

    const btn = $("submit-btn");
    btn.disabled = true;
    btn.textContent = "Reservando…";
    try {
      await store.create(booking);
      const mine = readJSON(MY_KEY, []);
      mine.push({ code: booking.code, service: booking.service, date: booking.date, time: booking.time, people: booking.people });
      writeJSON(MY_KEY, mine);

      const s = svc();
      $("confirm-text").textContent = `${booking.name}, te esperamos el ${fmtDate(booking.date)} a las ${booking.time} para "${s.name}" (${booking.people} persona${booking.people > 1 ? "s" : ""}, ${euro(booking.people * s.price)}).`;
      $("confirm-code").textContent = booking.code;
      $("confirm-dialog").showModal();

      $("booking-form").reset();
      $("service").value = state.service;
      state.time = null;
      await loadMonth();
      renderMyBookings();
    } catch (err) {
      $("form-error").textContent = err.message;
      await loadMonth();
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirmar reserva";
    }
  }

  // ---------- Eventos ----------
  function bind() {
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
  }

  renderServices();
  bind();
  renderMyBookings();
  loadMonth();
})();
