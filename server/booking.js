import { randomInt } from "node:crypto";
import { tx, rowToService } from "./db.js";
import { HttpError } from "./security.js";
import { nowLocal, addDays, daysBetween, weekday, month, isISODate, isHM, minutesUntil } from "./time.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function newCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `VAC-${s}`;
}

export function getService(db, id, { includeInactive = false } = {}) {
  const row = db.prepare("select * from services where id = ?").get(id);
  if (!row || (!includeInactive && !row.active)) return null;
  return rowToService(row);
}

export function listServices(db, { includeInactive = false } = {}) {
  const rows = db.prepare(`select * from services ${includeInactive ? "" : "where active = 1"} order by sort, name`).all();
  return rows.map(rowToService);
}

/** Cierres (por mal tiempo, festivos…) de una actividad en un rango: { fecha: motivo }. */
function closuresFor(db, serviceId, from, to) {
  const rows = db.prepare(`select date, reason from closures
    where date between ? and ? and (service is null or service = ?)`).all(from, to, serviceId);
  return Object.fromEntries(rows.map((r) => [r.date, r.reason || "Cerrado"]));
}

function takenFor(db, serviceId, from, to) {
  const rows = db.prepare(`select date, time, sum(people) as people from bookings
    where service = ? and status = 'confirmed' and date between ? and ?
    group by date, time`).all(serviceId, from, to);
  const map = {};
  for (const r of rows) map[`${r.date}|${r.time}`] = r.people;
  return map;
}

const runsOn = (svc, date) => svc.days.includes(weekday(date)) && (!svc.months || svc.months.includes(month(date)));

/**
 * Plazas libres por día y hora dentro de [from, to], recortado a la ventana reservable.
 * Devuelve { from, to, days: { "YYYY-MM-DD": { closed?: motivo, slots: { "HH:MM": libres } } } }.
 * Solo aparecen los días en que la actividad sale.
 */
export function availability(db, svc, from, to, { windowDays, at = new Date() }) {
  const now = nowLocal(at);
  const lastDay = addDays(now.date, windowDays);
  if (!isISODate(from) || from < now.date) from = now.date;
  if (!isISODate(to) || to > lastDay) to = lastDay;
  if (daysBetween(from, to) > 62) to = addDays(from, 62);

  const days = {};
  if (from > to) return { from, to, days };

  const closed = closuresFor(db, svc.id, from, to);
  const taken = takenFor(db, svc.id, from, to);

  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!runsOn(svc, d)) continue;
    if (closed[d]) { days[d] = { closed: closed[d], slots: {} }; continue; }
    const slots = {};
    for (const t of svc.slots) {
      if (d === now.date && t <= now.time) continue;
      slots[t] = Math.max(0, svc.capacity - (taken[`${d}|${t}`] || 0));
    }
    days[d] = { slots };
  }
  return { from, to, days };
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

export function validateBookingInput(body) {
  const b = body || {};
  const input = {
    service: cleanText(b.service, 40),
    date: b.date,
    time: b.time,
    people: Number(b.people),
    name: cleanText(b.name, 100),
    email: cleanText(b.email, 200).toLowerCase(),
    phone: cleanText(b.phone, 30),
    notes: typeof b.notes === "string" ? b.notes.trim().slice(0, 500) : "",
  };
  if (!input.service) throw new HttpError(400, "Elige una actividad.");
  if (!isISODate(input.date)) throw new HttpError(400, "Elige un día.");
  if (!isHM(input.time)) throw new HttpError(400, "Elige una hora.");
  if (!Number.isInteger(input.people) || input.people < 1) throw new HttpError(400, "Indica el número de personas.");
  if (input.name.length < 2) throw new HttpError(400, "Escribe tu nombre.");
  if (!EMAIL_RE.test(input.email)) throw new HttpError(400, "Escribe un email válido.");
  if (input.phone.replace(/\D/g, "").length < 9) throw new HttpError(400, "Escribe un teléfono válido.");
  return input;
}

/** Crea una reserva comprobando plazas dentro de una transacción (evita overbooking). */
export function createBooking(db, body, { windowDays, at = new Date() }) {
  const input = validateBookingInput(body);
  const svc = getService(db, input.service);
  if (!svc) throw new HttpError(400, "Actividad no válida.");

  return tx(db, () => {
    const av = availability(db, svc, input.date, input.date, { windowDays, at });
    const day = av.days[input.date];
    if (!day) throw new HttpError(409, "Esa fecha no está disponible.");
    if (day.closed) throw new HttpError(409, `Ese día no hay salidas: ${day.closed}.`);
    const free = day.slots[input.time];
    if (free === undefined) throw new HttpError(409, "Ese horario no está disponible.");
    if (input.people > free) {
      throw new HttpError(409, free === 0 ? "Ese horario ya está completo." : `Solo quedan ${free} plazas en ese horario.`);
    }

    const booking = { code: newCode(), ...input, total: input.people * svc.price, status: "confirmed" };
    db.prepare(`insert into bookings (code, service, date, time, people, total, name, email, phone, notes)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      booking.code, booking.service, booking.date, booking.time, booking.people, booking.total,
      booking.name, booking.email, booking.phone, booking.notes || null,
    );
    return publicBooking(db, booking.code);
  });
}

/** Datos de una reserva que se pueden enseñar al cliente (sin teléfono ni notas). */
export function publicBooking(db, code) {
  const r = db.prepare(`select b.*, s.name as service_name, s.emoji as service_emoji
    from bookings b join services s on s.id = b.service where b.code = ?`).get(code);
  if (!r) return null;
  return {
    code: r.code, service: r.service, serviceName: r.service_name, serviceEmoji: r.service_emoji,
    date: r.date, time: r.time, people: r.people, total: r.total, name: r.name, status: r.status,
  };
}

/** Busca una reserva por código + email (el email hace de contraseña para el cliente). */
export function findOwnBooking(db, code, email) {
  const c = cleanText(code, 20).toUpperCase();
  const e = cleanText(email, 200).toLowerCase();
  const row = db.prepare("select code from bookings where code = ? and email = ?").get(c, e);
  if (!row) throw new HttpError(404, "No encontramos ninguna reserva con ese código y email.");
  return publicBooking(db, row.code);
}

export function cancelBooking(db, code, { byAdmin = false, cancelHours = 24, at = new Date() } = {}) {
  const b = db.prepare("select * from bookings where code = ?").get(code);
  if (!b) throw new HttpError(404, "Reserva no encontrada.");
  if (b.status === "cancelled") throw new HttpError(409, "La reserva ya estaba cancelada.");
  if (!byAdmin && minutesUntil(b.date, b.time, at) < cancelHours * 60) {
    throw new HttpError(409, `Solo se puede cancelar online hasta ${cancelHours} h antes. Llámanos y lo vemos.`);
  }
  db.prepare("update bookings set status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where code = ?").run(code);
  return publicBooking(db, code);
}

// ---------- Validación de actividades (panel de admin) ----------

export function validateServiceInput(body, { isNew }) {
  const b = body || {};
  const s = {
    id: cleanText(b.id, 40).toLowerCase(),
    name: cleanText(b.name, 100),
    emoji: cleanText(b.emoji, 8) || "⛰️",
    description: typeof b.description === "string" ? b.description.trim().slice(0, 400) : "",
    duration: cleanText(b.duration, 20),
    price: Number(b.price),
    capacity: Number(b.capacity),
    slots: Array.isArray(b.slots) ? [...new Set(b.slots)].sort() : null,
    days: Array.isArray(b.days) ? [...new Set(b.days.map(Number))].sort() : null,
    months: Array.isArray(b.months) && b.months.length ? [...new Set(b.months.map(Number))].sort((x, y) => x - y) : null,
    active: b.active === undefined ? true : !!b.active,
  };
  if (isNew && !/^[a-z0-9-]{2,40}$/.test(s.id)) throw new HttpError(400, "El identificador solo puede tener minúsculas, números y guiones.");
  if (s.name.length < 2) throw new HttpError(400, "Escribe el nombre de la actividad.");
  if (!Number.isInteger(s.price) || s.price < 0 || s.price > 10000) throw new HttpError(400, "Precio no válido.");
  if (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 500) throw new HttpError(400, "Plazas no válidas.");
  if (!s.slots?.length || !s.slots.every(isHM)) throw new HttpError(400, "Añade al menos una hora de salida válida (HH:MM).");
  if (!s.days?.length || !s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new HttpError(400, "Elige al menos un día de la semana.");
  if (s.months && !s.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) throw new HttpError(400, "Meses no válidos.");
  return s;
}
