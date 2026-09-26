# Vive Alto Campoo

Web de reservas de rutas y paseos en Alto Campoo (Cantabria), con **frontend** (web pública + panel de gestión) y **backend** (API en Node.js con base de datos SQLite).

## Qué incluye

**Web pública** (`/`)
- Actividades cargadas desde la base de datos.
- Calendario con plazas libres en tiempo real (se refresca al volver a la pestaña).
- Reserva con control de plazas en el servidor: nunca hay overbooking, aunque dos personas reserven a la vez.
- "Mis reservas" en el dispositivo y **consulta/cancelación** con código + email (hasta 24 h antes).
- Formulario de contacto.

**Panel de gestión** (`/admin`, protegido con contraseña)
- **Resumen:** personas de los próximos 7 días, ingresos del mes, próximas salidas con ocupación.
- **Reservas:** filtros por fecha, actividad, estado y búsqueda; cancelar; exportar a CSV (Excel).
- **Actividades:** crear, editar precio/plazas/horarios/días/temporada, ocultar.
- **Cierres:** bloquear un día (mal tiempo, festivos) para una o todas las actividades; avisa si ya hay reservas ese día.
- **Mensajes** del formulario de contacto.

## Estructura

| Ruta | Para qué sirve |
|---|---|
| `server/index.js` | Arranque y variables de entorno |
| `server/app.js` | Rutas de la API (pública y admin) |
| `server/booking.js` | Disponibilidad, reservas, cancelaciones, validación |
| `server/db.js` | Esquema SQLite y conexión |
| `server/seed.js` | Actividades iniciales (solo al crear la BD) |
| `server/security.js` | Sesión admin (cookie firmada), límite de peticiones, cabeceras |
| `server/time.js` | Fechas en hora de Madrid |
| `public/` | Frontend: `index.html`, `app.js`, `admin.html`, `admin.js`, estilos |
| `test/` | Tests de la API |

## Probar en local

Necesitas **Node.js 22.5 o superior** (usa el SQLite integrado en Node, sin dependencias nativas).

```bash
npm install
ADMIN_PASSWORD=loquequieras npm run dev
```

Abre http://localhost:3000 (web) y http://localhost:3000/admin (panel). Si no defines `ADMIN_PASSWORD`, se genera una temporal y se muestra en la consola.

```bash
npm test
```

## Variables de entorno

| Variable | Por defecto | |
|---|---|---|
| `ADMIN_PASSWORD` | — | Contraseña del panel. **Obligatoria en producción.** |
| `SESSION_SECRET` | aleatoria | Firma de la sesión. Ponla fija para que no se cierre sesión al reiniciar. |
| `PORT` | `3000` | |
| `DATABASE_FILE` | `data/vive-alto-campoo.db` | Archivo SQLite. Debe estar en un disco persistente. |
| `BOOKING_WINDOW_DAYS` | `90` | Días reservables hacia delante |
| `CANCEL_HOURS` | `24` | Horas mínimas para que el cliente cancele online |
| `NODE_ENV` | — | `production` activa cookies `Secure` y caché de estáticos |

## Publicar

GitHub Pages solo sirve archivos estáticos, así que ya no sirve para esta versión. Cualquier hosting con Node o Docker vale; lo importante es que el archivo de la base de datos esté en un **disco persistente**:

- **Docker** (Fly.io, Railway, un VPS…):
  ```bash
  docker build -t vive-alto-campoo .
  docker run -p 3000:3000 -v vac-data:/data -e ADMIN_PASSWORD=... -e SESSION_SECRET=... vive-alto-campoo
  ```
- **Render / Railway sin Docker:** comando de build `npm ci`, de arranque `npm start`, y añade un disco/volumen montado donde apunte `DATABASE_FILE`.

**Copia de seguridad:** basta con copiar el archivo `.db` (o exportar el CSV desde el panel).

## API

| Método | Ruta | |
|---|---|---|
| GET | `/api/config` | Fecha de hoy, ventana de reservas, horas de cancelación |
| GET | `/api/services` | Actividades visibles |
| GET | `/api/services/:id/availability?from&to` | Plazas libres por día y hora |
| POST | `/api/bookings` | Crear reserva |
| POST | `/api/bookings/lookup` | Consultar reserva (`code`, `email`) |
| POST | `/api/bookings/cancel` | Cancelar reserva (`code`, `email`) |
| POST | `/api/messages` | Mensaje de contacto |
| — | `/api/admin/*` | Panel (requiere sesión): `login`, `stats`, `bookings`, `bookings.csv`, `services`, `closures`, `messages` |
