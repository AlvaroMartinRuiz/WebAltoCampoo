import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SEED_SERVICES } from "./seed.js";

const SCHEMA = `
  create table if not exists services (
    id          text primary key,
    name        text not null,
    emoji       text not null default '⛰️',
    description text not null default '',
    duration    text not null default '',
    price       integer not null check (price >= 0),
    capacity    integer not null check (capacity > 0),
    slots       text not null,            -- JSON ["09:30", …]
    days        text not null,            -- JSON [0..6], 0 = domingo
    months      text,                     -- JSON [1..12] o null = todo el año
    active      integer not null default 1,
    sort        integer not null default 0
  );

  create table if not exists bookings (
    code         text primary key,
    service      text not null references services(id),
    date         text not null,
    time         text not null,
    people       integer not null check (people > 0),
    total        integer not null,
    name         text not null,
    email        text not null,
    phone        text not null,
    notes        text,
    status       text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
    created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cancelled_at text
  );
  create index if not exists bookings_slot on bookings(service, date, time) where status = 'confirmed';
  create index if not exists bookings_date on bookings(date);

  create table if not exists closures (
    id      integer primary key autoincrement,
    date    text not null,
    service text references services(id) on delete cascade,  -- null = todas las actividades
    reason  text not null default ''
  );
  create index if not exists closures_date on closures(date);

  create table if not exists messages (
    id         integer primary key autoincrement,
    name       text not null,
    email      text not null,
    message    text not null,
    read       integer not null default 0,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

export function openDb(file = ":memory:") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec(SCHEMA);

  const { n } = db.prepare("select count(*) as n from services").get();
  if (n === 0) {
    const insert = db.prepare(`insert into services (id, name, emoji, description, duration, price, capacity, slots, days, months, sort)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    SEED_SERVICES.forEach((s, i) => insert.run(
      s.id, s.name, s.emoji, s.description, s.duration, s.price, s.capacity,
      JSON.stringify(s.slots), JSON.stringify(s.days), s.months ? JSON.stringify(s.months) : null, i,
    ));
  }
  return db;
}

/** Ejecuta fn dentro de una transacción (BEGIN IMMEDIATE bloquea escrituras concurrentes). */
export function tx(db, fn) {
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

export function rowToService(r) {
  return {
    id: r.id, name: r.name, emoji: r.emoji, description: r.description, duration: r.duration,
    price: r.price, capacity: r.capacity,
    slots: JSON.parse(r.slots), days: JSON.parse(r.days), months: r.months ? JSON.parse(r.months) : null,
    active: !!r.active, sort: r.sort,
  };
}
