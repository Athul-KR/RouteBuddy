/** Local-time helpers. The server uses TZ (set in .env, default Asia/Kolkata). */
export function today(d = new Date()): string {
  return localParts(d).date;
}

export function localParts(d = new Date()) {
  const tz = process.env.TZ_NAME ?? 'Asia/Kolkata';
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: dayIdx,
    minutes: Number(hour) * 60 + Number(p.minute),
  };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function inQuietHours(now: number, start: string, end: string): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

/** Metres between two lon/lat points. */
export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Smallest distance in metres from point p to a polyline (flat approximation, fine at city scale). */
export function distanceToLine(p: [number, number], line: [number, number][]): number {
  let best = Infinity;
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111320;
  const ky = 110540;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * ky;
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

export function bbox(line: [number, number][], padDeg = 0.01): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of line) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX - padDeg, minY - padDeg, maxX + padDeg, maxY + padDeg];
}

/** Small in-memory TTL cache. */
export class TtlCache<T> {
  private store = new Map<string, { v: T; exp: number }>();
  get(k: string): T | undefined {
    const e = this.store.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.store.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: T, ttlMs: number) { this.store.set(k, { v, exp: Date.now() + ttlMs }); }
  deletePrefix(prefix: string) { for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k); }
}

/**
 * Drops keys whose value is undefined. Validated DTOs carry every declared field,
 * set to undefined when the client left it out; assigning those would blank the entity.
 */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The point a given fraction of the way along a polyline, by distance (0.5 = halfway). */
export function pointAlong(line: [number, number][], fraction: number): [number, number] {
  if (line.length < 2) return line[0];
  const seg = line.slice(1).map((p, i) => haversine(line[i], p));
  let target = seg.reduce((a, b) => a + b, 0) * fraction;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] && seg[i] > 0) {
      const t = target / seg[i];
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
    }
    target -= seg[i];
  }
  return line[line.length - 1];
}
