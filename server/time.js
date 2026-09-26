// Fechas y horas siempre en la zona horaria del negocio (Cantabria).
export const TZ = "Europe/Madrid";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** Fecha ("YYYY-MM-DD") y hora ("HH:MM") actuales en Madrid. */
export function nowLocal(at = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const DAY_MS = 86_400_000;
const toUTC = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

export const isISODate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toUTC(s)) && new Date(toUTC(s)).toISOString().startsWith(s);
export const isHM = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function addDays(iso, n) {
  return new Date(toUTC(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

/** 0 = domingo … 6 = sábado */
export const weekday = (iso) => new Date(toUTC(iso)).getUTCDay();
export const month = (iso) => +iso.slice(5, 7);

/** Minutos que faltan (hora local) desde ahora hasta date+time. */
export function minutesUntil(date, time, at = new Date()) {
  const now = nowLocal(at);
  const toMin = (d, t) => toUTC(d) / 60_000 + +t.slice(0, 2) * 60 + +t.slice(3, 5);
  return toMin(date, time) - toMin(now.date, now.time);
}
