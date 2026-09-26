import { randomBytes } from "node:crypto";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const env = process.env;
const production = env.NODE_ENV === "production";

let adminPassword = env.ADMIN_PASSWORD;
if (!adminPassword) {
  if (production) {
    console.error("Falta la variable ADMIN_PASSWORD.");
    process.exit(1);
  }
  adminPassword = randomBytes(6).toString("base64url");
  console.warn(`ADMIN_PASSWORD no definida. Contraseña temporal del panel: ${adminPassword}`);
}

const db = openDb(env.DATABASE_FILE || "data/vive-alto-campoo.db");
const app = createApp({
  db,
  adminPassword,
  sessionSecret: env.SESSION_SECRET, // si falta, se genera una al arrancar (las sesiones caducan al reiniciar)
  windowDays: Number(env.BOOKING_WINDOW_DAYS) || 90,
  cancelHours: Number(env.CANCEL_HOURS) || 24,
  production,
});

const port = Number(env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`Vive Alto Campoo en http://localhost:${port}  (panel: /admin)`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
