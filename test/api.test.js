import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";

// Lunes 5 de octubre de 2026, 10:00 en Madrid.
const NOW = new Date("2026-10-05T08:00:00Z");
const TODAY = "2026-10-05";
const PASSWORD = "secreto-de-prueba";

let server, base, cookie = "";

before(async () => {
  const app = createApp({ db: openDb(":memory:"), adminPassword: PASSWORD, clock: () => NOW, rateLimits: false });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(path, { method = "GET", body, auth = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(auth ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const guest = { name: "Ana Pérez", email: "Ana@Example.com", phone: "600 123 456" };

test("sirve la web y la API de actividades", async () => {
  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);

  const { status, data } = await call("/api/services");
  assert.equal(status, 200);
  assert.deepEqual(data.map((s) => s.id), ["senderismo", "caballo", "ebike", "raquetas"]);

  const cfg = await call("/api/config");
  assert.equal(cfg.data.today, TODAY);
});

test("disponibilidad: oculta horas pasadas, días sin salida y fuera de temporada", async () => {
  const { data } = await call(`/api/services/senderismo/availability?from=2026-10-01&to=2026-10-31`);
  assert.equal(data.from, TODAY, "no devuelve días pasados");
  assert.deepEqual(data.days[TODAY].slots, { "15:30": 12 }, "09:30 ya ha pasado");

  const ebike = await call(`/api/services/ebike/availability?from=2026-10-05&to=2026-10-11`);
  assert.deepEqual(Object.keys(ebike.data.days), ["2026-10-09", "2026-10-10", "2026-10-11"], "solo vie–dom");

  const snow = await call(`/api/services/raquetas/availability?from=2026-10-05&to=2026-10-31`);
  assert.deepEqual(snow.data.days, {}, "raquetas solo en invierno");

  assert.equal((await call("/api/services/nada/availability")).status, 404);
});

test("reserva, descuenta plazas y evita overbooking", async () => {
  const body = { ...guest, service: "caballo", date: "2026-10-10", time: "10:00", people: 4 };
  const r1 = await call("/api/bookings", { method: "POST", body });
  assert.equal(r1.status, 201);
  assert.match(r1.data.code, /^VAC-[A-Z2-9]{6}$/);
  assert.equal(r1.data.total, 160);
  assert.equal(r1.data.phone, undefined, "no devuelve datos sensibles");

  const av = await call("/api/services/caballo/availability?from=2026-10-10&to=2026-10-10");
  assert.equal(av.data.days["2026-10-10"].slots["10:00"], 2);

  const r2 = await call("/api/bookings", { method: "POST", body: { ...body, people: 3 } });
  assert.equal(r2.status, 409);
  assert.match(r2.data.error, /Solo quedan 2/);

  const r3 = await call("/api/bookings", { method: "POST", body: { ...body, people: 2 } });
  assert.equal(r3.status, 201);
  const r4 = await call("/api/bookings", { method: "POST", body: { ...body, people: 1 } });
  assert.match(r4.data.error, /completo/);
});

test("rechaza reservas no válidas", async () => {
  const ok = { ...guest, service: "senderismo", date: "2026-10-12", time: "09:30", people: 1 };
  const cases = [
    [{ ...ok, email: "no-es-email" }, 400],
    [{ ...ok, phone: "123" }, 400],
    [{ ...ok, people: 0 }, 400],
    [{ ...ok, date: "2026-02-30" }, 400],
    [{ ...ok, time: "11:11" }, 409],             // hora que no existe
    [{ ...ok, date: "2026-10-04" }, 409],        // ayer
    [{ ...ok, date: TODAY, time: "09:30" }, 409], // ya ha salido
    [{ ...ok, date: "2027-06-01" }, 409],        // fuera de la ventana de 90 días
    [{ ...ok, service: "ebike", date: "2026-10-12" }, 409], // lunes: no hay bici
    [{ ...ok, service: "inventada" }, 400],
  ];
  for (const [body, status] of cases) {
    const r = await call("/api/bookings", { method: "POST", body });
    assert.equal(r.status, status, JSON.stringify(body));
    assert.ok(r.data.error);
  }
  assert.equal((await call("/api/bookings", { method: "POST", body: ok })).status, 201);
});

test("el cliente consulta y cancela con código + email", async () => {
  const soon = await call("/api/bookings", { method: "POST", body: { ...guest, service: "senderismo", date: TODAY, time: "15:30", people: 2 } });
  const later = await call("/api/bookings", { method: "POST", body: { ...guest, service: "senderismo", date: "2026-10-20", time: "15:30", people: 5 } });

  assert.equal((await call("/api/bookings/lookup", { method: "POST", body: { code: later.data.code, email: "otra@example.com" } })).status, 404);
  const found = await call("/api/bookings/lookup", { method: "POST", body: { code: later.data.code.toLowerCase(), email: " ana@example.com " } });
  assert.equal(found.status, 200);
  assert.equal(found.data.status, "confirmed");

  const tooLate = await call("/api/bookings/cancel", { method: "POST", body: { code: soon.data.code, email: guest.email } });
  assert.equal(tooLate.status, 409, "menos de 24 h");

  const cancelled = await call("/api/bookings/cancel", { method: "POST", body: { code: later.data.code, email: guest.email } });
  assert.equal(cancelled.data.status, "cancelled");
  const av = await call("/api/services/senderismo/availability?from=2026-10-20&to=2026-10-20");
  assert.equal(av.data.days["2026-10-20"].slots["15:30"], 12, "libera las plazas");

  const again = await call("/api/bookings/cancel", { method: "POST", body: { code: later.data.code, email: guest.email } });
  assert.equal(again.status, 409);
});

test("mensajes de contacto", async () => {
  assert.equal((await call("/api/messages", { method: "POST", body: { name: "Luis", email: "x", message: "hola hola" } })).status, 400);
  assert.equal((await call("/api/messages", { method: "POST", body: { name: "Luis", email: "luis@example.com", message: "¿Hacéis grupos de 20?" } })).status, 201);
});

test("el panel exige contraseña", async () => {
  assert.equal((await call("/api/admin/stats")).status, 401);
  assert.equal((await call("/api/admin/bookings", { auth: true })).status, 401);
  assert.equal((await call("/api/admin/login", { method: "POST", body: { password: "mala" } })).status, 401);

  const res = await fetch(base + "/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  cookie = setCookie.split(";")[0];

  assert.equal((await call("/api/admin/me", { auth: true })).data.loggedIn, true);
  const [name, value] = cookie.split("=");
  const forged = await fetch(base + "/api/admin/stats", { headers: { Cookie: `${name}=${value.split(".")[0]}9.${value.split(".")[1]}` } });
  assert.equal(forged.status, 401, "rechaza cookies manipuladas");
});

test("admin: estadísticas, listado, CSV y cancelación", async () => {
  const stats = await call("/api/admin/stats", { auth: true });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.unread, 1);
  assert.ok(stats.data.departures.some((d) => d.service === "caballo" && d.people === 6));

  const list = await call("/api/admin/bookings?service=caballo&status=confirmed", { auth: true });
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].phone, "600 123 456");

  const search = await call("/api/admin/bookings?q=ana%40example", { auth: true });
  assert.ok(search.data.length >= 4);

  const csv = await call("/api/admin/bookings.csv?service=caballo", { auth: true });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.data, /^code;status;date/); // text() quita el BOM

  // El admin puede cancelar aunque falten menos de 24 h.
  const today = await call(`/api/admin/bookings?from=${TODAY}&to=${TODAY}&status=confirmed`, { auth: true });
  const r = await call(`/api/admin/bookings/${today.data[0].code}/cancel`, { method: "POST", auth: true });
  assert.equal(r.data.status, "cancelled");
});

test("admin: editar y crear actividades", async () => {
  const svc = (await call("/api/admin/services", { auth: true })).data.find((s) => s.id === "ebike");
  const upd = await call("/api/admin/services/ebike", { method: "PUT", auth: true, body: { ...svc, price: 50, capacity: 10, days: [1, 5, 6, 0] } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.price, 50);
  const av = await call("/api/services/ebike/availability?from=2026-10-12&to=2026-10-12");
  assert.equal(av.data.days["2026-10-12"].slots["10:00"], 10, "ahora sale los lunes con 10 plazas");

  const bad = await call("/api/admin/services/ebike", { method: "PUT", auth: true, body: { ...svc, slots: ["25:00"] } });
  assert.equal(bad.status, 400);

  const hidden = await call("/api/admin/services/raquetas", { method: "PUT", auth: true, body: { ...svc, name: "Raquetas", active: false } });
  assert.equal(hidden.data.active, false);
  assert.ok(!(await call("/api/services")).data.some((s) => s.id === "raquetas"), "las ocultas no salen en la web");

  const created = await call("/api/admin/services", {
    method: "POST", auth: true,
    body: { id: "kayak", name: "Kayak en el Ebro", price: 30, capacity: 8, slots: ["11:00"], days: [6, 0], months: [6, 7, 8, 9, 10] },
  });
  assert.equal(created.status, 201);
  assert.equal((await call("/api/admin/services", { method: "POST", auth: true, body: { ...created.data } })).status, 409);
});

test("admin: los cierres bloquean reservas", async () => {
  const c = await call("/api/admin/closures", { method: "POST", auth: true, body: { date: "2026-10-10", reason: "Temporal" } });
  assert.equal(c.status, 201);
  assert.equal(c.data.affected, 2, "avisa de las reservas afectadas");

  const av = await call("/api/services/caballo/availability?from=2026-10-10&to=2026-10-10");
  assert.equal(av.data.days["2026-10-10"].closed, "Temporal");
  const r = await call("/api/bookings", { method: "POST", body: { ...guest, service: "senderismo", date: "2026-10-10", time: "09:30", people: 1 } });
  assert.equal(r.status, 409);

  assert.equal((await call(`/api/admin/closures/${c.data.id}`, { method: "DELETE", auth: true })).status, 200);
  const r2 = await call("/api/bookings", { method: "POST", body: { ...guest, service: "senderismo", date: "2026-10-10", time: "09:30", people: 1 } });
  assert.equal(r2.status, 201);
});

test("admin: mensajes", async () => {
  const list = await call("/api/admin/messages", { auth: true });
  assert.equal(list.data.length, 1);
  await call(`/api/admin/messages/${list.data[0].id}`, { method: "PATCH", auth: true, body: { read: true } });
  assert.equal((await call("/api/admin/stats", { auth: true })).data.unread, 0);
  assert.equal((await call(`/api/admin/messages/${list.data[0].id}`, { method: "DELETE", auth: true })).status, 200);
});
