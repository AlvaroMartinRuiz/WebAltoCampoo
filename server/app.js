import express from "express";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tx } from "./db.js";
import { HttpError, createAuth, rateLimit, securityHeaders } from "./security.js";
import {
  listServices, getService, availability, createBooking, findOwnBooking, cancelBooking,
  validateServiceInput,
} from "./booking.js";
import { nowLocal, addDays, isISODate } from "./time.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} opts
 * @param {import("node:sqlite").DatabaseSync} opts.db
 * @param {string} opts.adminPassword
 * @param {string} [opts.sessionSecret]
 * @param {number} [opts.windowDays]   días reservables hacia delante
 * @param {number} [opts.cancelHours]  horas mínimas para cancelar online
 * @param {boolean} [opts.production]
 * @param {() => Date} [opts.clock]    para tests
 */
export function createApp({
  db, adminPassword, sessionSecret, windowDays = 90, cancelHours = 24, production = false,
  clock = () => new Date(), rateLimits = true,
}) {
  const app = express();
  const auth = createAuth({ password: adminPassword, secret: sessionSecret, secureCookie: production });
  const limit = (windowMs, max) => (rateLimits ? rateLimit({ windowMs, max }) : (_q, _s, n) => n());

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: "20kb" }));

  // ---------- API pública ----------
  const api = express.Router();

  api.get("/config", (_req, res) => {
    res.json({ windowDays, cancelHours, today: nowLocal(clock()).date });
  });

  api.get("/services", (_req, res) => {
    res.json(listServices(db));
  });

  api.get("/services/:id/availability", (req, res) => {
    const svc = getService(db, req.params.id);
    if (!svc) throw new HttpError(404, "Actividad no encontrada.");
    res.set("Cache-Control", "no-store");
    res.json(availability(db, svc, req.query.from, req.query.to, { windowDays, at: clock() }));
  });

  api.post("/bookings", limit(10 * 60_000, 20), (req, res) => {
    const booking = createBooking(db, req.body, { windowDays, at: clock() });
    res.status(201).json(booking);
  });

  // El cliente consulta / cancela su reserva con código + email.
  api.post("/bookings/lookup", limit(10 * 60_000, 30), (req, res) => {
    res.json(findOwnBooking(db, req.body?.code, req.body?.email));
  });

  api.post("/bookings/cancel", limit(10 * 60_000, 20), (req, res) => {
    const b = findOwnBooking(db, req.body?.code, req.body?.email);
    res.json(cancelBooking(db, b.code, { cancelHours, at: clock() }));
  });

  api.post("/messages", limit(10 * 60_000, 5), (req, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 100);
    const email = String(req.body?.email ?? "").trim().slice(0, 200);
    const message = String(req.body?.message ?? "").trim().slice(0, 2000);
    if (name.length < 2) throw new HttpError(400, "Escribe tu nombre.");
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Escribe un email válido.");
    if (message.length < 5) throw new HttpError(400, "Escribe tu mensaje.");
    db.prepare("insert into messages (name, email, message) values (?, ?, ?)").run(name, email, message);
    res.status(201).json({ ok: true });
  });

  // ---------- API de administración ----------
  const admin = express.Router();

  admin.post("/login", limit(15 * 60_000, 10), (req, res) => {
    if (!auth.checkPassword(req.body?.password)) throw new HttpError(401, "Contraseña incorrecta.");
    auth.issue(res);
    res.json({ ok: true });
  });

  admin.post("/logout", (_req, res) => {
    auth.clear(res);
    res.json({ ok: true });
  });

  admin.get("/me", (req, res) => res.json({ loggedIn: auth.isValid(req) }));

  admin.use(auth.requireAdmin);
  admin.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  admin.get("/stats", (_req, res) => {
    const today = nowLocal(clock()).date;
    const in7 = addDays(today, 6);
    const monthStart = today.slice(0, 8) + "01";
    const monthEnd = today.slice(0, 8) + "31";
    const one = (sql, ...p) => db.prepare(sql).get(...p);

    const next7 = one(`select count(*) as bookings, coalesce(sum(people), 0) as people from bookings
      where status = 'confirmed' and date between ? and ?`, today, in7);
    const month = one(`select count(*) as bookings, coalesce(sum(total), 0) as revenue from bookings
      where status = 'confirmed' and date between ? and ?`, monthStart, monthEnd);
    const createdToday = one(`select count(*) as n from bookings where substr(created_at, 1, 10) = ?`, today).n;
    const unread = one("select count(*) as n from messages where read = 0").n;

    const departures = db.prepare(`select b.date, b.time, b.service, s.name, s.emoji, s.capacity,
        sum(b.people) as people, count(*) as bookings
      from bookings b join services s on s.id = b.service
      where b.status = 'confirmed' and b.date between ? and ?
      group by b.date, b.time, b.service order by b.date, b.time`).all(today, in7);

    const byService = db.prepare(`select s.id, s.name, s.emoji, count(b.code) as bookings,
        coalesce(sum(b.people), 0) as people, coalesce(sum(b.total), 0) as revenue
      from services s left join bookings b on b.service = s.id and b.status = 'confirmed' and b.date between ? and ?
      group by s.id order by s.sort`).all(monthStart, monthEnd);

    res.json({ today, next7, month, createdToday, unread, departures, byService });
  });

  function queryBookings(q) {
    const where = [];
    const params = [];
    if (isISODate(q.from)) { where.push("b.date >= ?"); params.push(q.from); }
    if (isISODate(q.to)) { where.push("b.date <= ?"); params.push(q.to); }
    if (q.service) { where.push("b.service = ?"); params.push(String(q.service)); }
    if (q.status === "confirmed" || q.status === "cancelled") { where.push("b.status = ?"); params.push(q.status); }
    if (q.q) {
      where.push("(b.code like ? or b.name like ? or b.email like ? or b.phone like ?)");
      const like = `%${String(q.q).slice(0, 100)}%`;
      params.push(like, like, like, like);
    }
    return db.prepare(`select b.*, s.name as service_name, s.emoji as service_emoji
      from bookings b join services s on s.id = b.service
      ${where.length ? "where " + where.join(" and ") : ""}
      order by b.date, b.time, b.created_at limit 1000`).all(...params);
  }

  admin.get("/bookings", (req, res) => res.json(queryBookings(req.query)));

  admin.get("/bookings.csv", (req, res) => {
    const cols = ["code", "status", "date", "time", "service_name", "people", "total", "name", "email", "phone", "notes", "created_at"];
    const esc = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita inyección de fórmulas en Excel
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = queryBookings(req.query).map((r) => cols.map((c) => esc(r[c])).join(";"));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="reservas-${nowLocal(clock()).date}.csv"`);
    res.send("﻿" + [cols.join(";"), ...rows].join("\r\n"));
  });

  admin.post("/bookings/:code/cancel", (req, res) => {
    res.json(cancelBooking(db, req.params.code, { byAdmin: true }));
  });

  admin.get("/services", (_req, res) => res.json(listServices(db, { includeInactive: true })));

  admin.post("/services", (req, res) => {
    const s = validateServiceInput(req.body, { isNew: true });
    if (getService(db, s.id, { includeInactive: true })) throw new HttpError(409, "Ya existe una actividad con ese identificador.");
    const { sort } = db.prepare("select coalesce(max(sort), -1) + 1 as sort from services").get();
    db.prepare(`insert into services (id, name, emoji, description, duration, price, capacity, slots, days, months, active, sort)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      s.id, s.name, s.emoji, s.description, s.duration, s.price, s.capacity,
      JSON.stringify(s.slots), JSON.stringify(s.days), s.months ? JSON.stringify(s.months) : null, s.active ? 1 : 0, sort,
    );
    res.status(201).json(getService(db, s.id, { includeInactive: true }));
  });

  admin.put("/services/:id", (req, res) => {
    if (!getService(db, req.params.id, { includeInactive: true })) throw new HttpError(404, "Actividad no encontrada.");
    const s = validateServiceInput(req.body, { isNew: false });
    db.prepare(`update services set name = ?, emoji = ?, description = ?, duration = ?, price = ?, capacity = ?,
      slots = ?, days = ?, months = ?, active = ? where id = ?`).run(
      s.name, s.emoji, s.description, s.duration, s.price, s.capacity,
      JSON.stringify(s.slots), JSON.stringify(s.days), s.months ? JSON.stringify(s.months) : null, s.active ? 1 : 0,
      req.params.id,
    );
    res.json(getService(db, req.params.id, { includeInactive: true }));
  });

  admin.get("/closures", (_req, res) => {
    const today = nowLocal(clock()).date;
    res.json(db.prepare(`select c.*, s.name as service_name from closures c left join services s on s.id = c.service
      where c.date >= ? order by c.date`).all(today));
  });

  admin.post("/closures", (req, res) => {
    const { date, service, reason } = req.body || {};
    if (!isISODate(date)) throw new HttpError(400, "Fecha no válida.");
    if (service && !getService(db, service, { includeInactive: true })) throw new HttpError(400, "Actividad no válida.");
    const text = String(reason ?? "").trim().slice(0, 120);
    const out = tx(db, () => {
      const { lastInsertRowid } = db.prepare("insert into closures (date, service, reason) values (?, ?, ?)").run(date, service || null, text);
      // Reservas afectadas, para poder avisar a los clientes.
      const affected = db.prepare(`select count(*) as n from bookings where status = 'confirmed' and date = ?
        ${service ? "and service = ?" : ""}`).get(...(service ? [date, service] : [date])).n;
      return { id: Number(lastInsertRowid), affected };
    });
    res.status(201).json(out);
  });

  admin.delete("/closures/:id", (req, res) => {
    const { changes } = db.prepare("delete from closures where id = ?").run(Number(req.params.id));
    if (!changes) throw new HttpError(404, "Cierre no encontrado.");
    res.json({ ok: true });
  });

  admin.get("/messages", (_req, res) => {
    res.json(db.prepare("select * from messages order by created_at desc limit 200").all());
  });

  admin.patch("/messages/:id", (req, res) => {
    const { changes } = db.prepare("update messages set read = ? where id = ?").run(req.body?.read ? 1 : 0, Number(req.params.id));
    if (!changes) throw new HttpError(404, "Mensaje no encontrado.");
    res.json({ ok: true });
  });

  admin.delete("/messages/:id", (req, res) => {
    const { changes } = db.prepare("delete from messages where id = ?").run(Number(req.params.id));
    if (!changes) throw new HttpError(404, "Mensaje no encontrado.");
    res.json({ ok: true });
  });

  api.use("/admin", admin);
  api.use((_req, _res, next) => next(new HttpError(404, "Ruta no encontrada.")));
  app.use("/api", api);

  // ---------- Frontend ----------
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/admin", (_req, res) => res.sendFile(join(PUBLIC_DIR, "admin.html")));
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: production ? "1h" : 0 }));

  // ---------- Errores ----------
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") err = new HttpError(400, "Petición no válida.");
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Error interno. Inténtalo de nuevo." : err.message });
  });

  return app;
}

