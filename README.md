# Vive Alto Campoo

Web de reservas de rutas y paseos en Alto Campoo (Cantabria). Es una web estática (HTML + CSS + JS, sin compilación) publicada con GitHub Pages.

**Web:** https://alvaromartinruiz.github.io/WebAltoCampoo/

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Página de inicio: actividades, reservas y "mis reservas" |
| `styles.css` | Estilos (incluye modo oscuro y móvil) |
| `config.js` | **Lo que editarás más:** actividades, precios, plazas, horarios, días |
| `app.js` | Lógica de calendario, disponibilidad y reservas |

## Cambiar actividades

Edita `config.js`. Cada actividad tiene:

- `capacity`: plazas por turno
- `slots`: horas de salida (`"10:00"`)
- `days`: días de la semana (0 = domingo … 6 = sábado)
- `months` (opcional): meses en que se ofrece (1–12)

## Dónde se guardan las reservas

GitHub Pages solo sirve archivos estáticos, así que no tiene base de datos.

- **Sin configurar nada (modo demo):** las reservas se guardan en el navegador de quien reserva. La web funciona, pero cada visitante solo ve sus propias reservas y **tú no las recibes**.
- **Con Supabase (gratis, recomendado para uso real):** las reservas se guardan en una base de datos compartida. Todos ven la misma disponibilidad y tú ves las reservas en el panel de Supabase.

### Activar Supabase

1. Crea una cuenta y un proyecto en https://supabase.com.
2. En **SQL Editor**, ejecuta:

```sql
-- Plazas por actividad (deben coincidir con config.js)
create table services (id text primary key, capacity int not null);
insert into services values
  ('senderismo', 12), ('caballo', 6), ('ebike', 8), ('raquetas', 10);

create table bookings (
  code text primary key,
  service text not null references services(id),
  date date not null,
  time text not null,
  people int not null check (people > 0),
  name text not null,
  email text not null,
  phone text not null,
  notes text,
  created_at timestamptz default now()
);

-- Nadie puede leer los datos personales desde la web
alter table bookings enable row level security;
alter table services enable row level security;

-- Vista pública con solo las plazas ocupadas por turno
create view slot_occupancy as
  select service, date, time, sum(people)::int as people
  from bookings group by service, date, time;
grant select on slot_occupancy to anon;

-- Reserva con comprobación de plazas (evita overbooking)
create function create_booking(
  p_code text, p_service text, p_date date, p_time text, p_people int,
  p_name text, p_email text, p_phone text, p_notes text
) returns void language plpgsql security definer set search_path = public as $$
declare cap int; taken int;
begin
  select capacity into cap from services where id = p_service for update;
  if cap is null then raise exception 'Actividad no válida'; end if;
  if p_date < current_date then raise exception 'Fecha no válida'; end if;
  select coalesce(sum(people), 0) into taken from bookings
    where service = p_service and date = p_date and time = p_time;
  if taken + p_people > cap then
    raise exception 'No quedan plazas suficientes en ese horario.';
  end if;
  insert into bookings values (p_code, p_service, p_date, p_time, p_people,
    p_name, p_email, p_phone, nullif(p_notes, ''), now());
end $$;
grant execute on function create_booking to anon;
```

3. En **Project Settings → API**, copia la *Project URL* y la clave *anon public*, y pégalas en `config.js`:

```js
supabase: {
  url: "https://xxxx.supabase.co",
  anonKey: "eyJ...",
},
```

4. Sube el cambio a GitHub. Las reservas aparecerán en **Table Editor → bookings**.

> La clave *anon* es pública por diseño; los datos personales quedan protegidos por las reglas de seguridad de arriba.

## Probar en local

Abre `index.html` en el navegador, o ejecuta `python -m http.server` y entra en http://localhost:8000.
