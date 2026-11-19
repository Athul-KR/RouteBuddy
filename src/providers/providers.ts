import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Parser from 'rss-parser';
import type { Vehicle } from '../common/entities.js';
import { distanceToLine, haversine, TtlCache } from '../common/util.js';
import { QuotaService } from './quota.service.js';

/**
 * Every outside service sits behind one class here, so swapping a provider touches one place.
 * Free, key-less services are used by default; TomTom and Geoapify switch on when their keys are set.
 */

const UA = () => process.env.MET_USER_AGENT ?? 'EverydayBuddy/0.1 (set MET_USER_AGENT in .env)';

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': UA(), ...headers }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new ServiceUnavailableException(`Upstream ${new URL(url).host} returned ${res.status}`);
  return (await res.json()) as T;
}

// ---------- Routing ----------

/** OSRM profile and a time factor per vehicle, as in the prototype. */
const VEHICLES: Record<Vehicle, { profile: string; factor: number; tomtom?: string }> = {
  car: { profile: 'routed-car', factor: 1.5, tomtom: 'car' },
  bike2: { profile: 'routed-car', factor: 1.25, tomtom: 'motorcycle' },
  cycle: { profile: 'routed-bike', factor: 1 },
  walk: { profile: 'routed-foot', factor: 1 },
};

export interface RouteResult {
  geometry: [number, number][];
  minutes: number;
  distanceKm: number;
}

export interface RouteOption extends RouteResult {
  usualMin: number;
  label: string;
  /** The road this option spends longest on, e.g. "Thenmala Road". */
  via?: string;
}

/** The street a route spends the most distance on, from TomTom's turn-by-turn instructions. */
export function mainRoad(instructions: { routeOffsetInMeters: number; street?: string }[], totalMetres: number): string | undefined {
  const byStreet = new Map<string, number>();
  instructions.forEach((ins, i) => {
    if (!ins.street) return;
    const next = instructions[i + 1]?.routeOffsetInMeters ?? totalMetres;
    byStreet.set(ins.street, (byStreet.get(ins.street) ?? 0) + Math.max(0, next - ins.routeOffsetInMeters));
  });
  return [...byStreet.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Trip minutes for a vehicle. TomTom's bicycle mode returns car-in-traffic times, so cycling (and walking)
 * is timed from distance at an everyday pace instead.
 */
export const CYCLE_KMH = 15;
export const WALK_KMH = 4.5;
export function tripMinutes(vehicle: Vehicle, seconds: number, metres: number): number {
  if (vehicle === 'cycle') return Math.max(1, Math.round((metres / 1000 / CYCLE_KMH) * 60));
  // Routers disagree on walking pace; one steady pace keeps the options comparable.
  if (vehicle === 'walk') return Math.max(1, Math.round((metres / 1000 / WALK_KMH) * 60));
  return Math.round(seconds / 60);
}

/** Compass bearing (0-359) from a to b, both [lon, lat]. */
export function bearing(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return Math.round((Math.atan2(y, x) / rad + 360) % 360);
}

/** Checkpoints along a path, about every `spacing` metres (at most `max`), each with its index and direction of travel. */
export function checkpoints(line: [number, number][], spacing: number, max: number): { p: [number, number]; i: number; heading: number }[] {
  if (line.length < 2) return [];
  const total = line.slice(1).reduce((s, p, i) => s + haversine(line[i], p), 0);
  const step = Math.max(spacing, total / (max - 2));
  const out: { p: [number, number]; i: number; heading: number }[] = [];
  let run = 0, next = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = haversine(line[i], line[i + 1]);
    if (seg === 0) continue;
    if (run >= next && out.length < max - 1) { out.push({ p: line[i], i, heading: bearing(line[i], line[i + 1]) }); next = run + step; }
    run += seg;
  }
  const n = line.length;
  out.push({ p: line[n - 1], i: n - 1, heading: bearing(line[n - 2], line[n - 1]) });
  return out;
}

export interface LiveRoute {
  minutes: number;
  delayMin: number;
  live: boolean;
}

@Injectable()
export class RoutingProvider {
  constructor(private quota: QuotaService) {}

  async route(from: [number, number], to: [number, number], vehicle: Vehicle): Promise<RouteResult> {
    const v = VEHICLES[vehicle] ?? VEHICLES.car;
    const url = `https://routing.openstreetmap.de/${v.profile}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`;
    const data = await getJson<{ routes: { geometry: { coordinates: [number, number][] }; duration: number; distance: number }[] }>(url);
    const r = data.routes?.[0];
    if (!r) throw new ServiceUnavailableException('No route found between these places');
    return {
      geometry: r.geometry.coordinates,
      minutes: Math.round((r.duration / 60) * v.factor),
      distanceKm: Math.round(r.distance / 100) / 10,
    };
  }

  private snapPausedUntil = 0;

  /**
   * Redraws a TomTom path on OpenStreetMap roads, which is what the map tiles show: TomTom's road data can sit
   * 10-20 m off the map's roads. The free router follows checkpoints along the same path, each with its direction
   * of travel so it keeps to the right carriageway. Each stretch between checkpoints uses the redrawn line only when
   * TomTom's path lies along it; elsewhere TomTom's own line stays.
   */
  async snapToMap(geometry: [number, number][], vehicle: Vehicle): Promise<[number, number][]> {
    const cps = checkpoints(geometry, 250, 60);
    // The free router is a shared public server: never let it slow a trip plan down.
    if (cps.length < 2 || Date.now() < this.snapPausedUntil) return geometry;
    const v = VEHICLES[vehicle] ?? VEHICLES.car;
    const coords = cps.map((c) => `${c.p[0].toFixed(6)},${c.p[1].toFixed(6)}`).join(';');
    // No direction at the two ends: the start or destination may sit on a lane the map doesn't have.
    const bearings = cps.map((c, i) => (i === 0 || i === cps.length - 1 ? '' : `${c.heading},90`)).join(';');
    const url = `https://routing.openstreetmap.de/${v.profile}/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson&continue_straight=true&bearings=${bearings}`;
    type Osrm = { routes?: { legs: { steps: { geometry: { coordinates: [number, number][] } }[] }[] }[] };
    let legs: [number, number][][];
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA() }, signal: AbortSignal.timeout(4000) });
      if (res.status >= 500 || res.status === 429) throw new Error(`router returned ${res.status}`);
      const r = res.ok ? ((await res.json()) as Osrm).routes?.[0] : undefined;
      if (!r || r.legs.length !== cps.length - 1) return geometry;
      legs = r.legs.map((l) => l.steps.flatMap((st) => st.geometry.coordinates));
    } catch {
      this.snapPausedUntil = Date.now() + 5 * 60 * 1000;
      return geometry;
    }
    const out: [number, number][] = [];
    legs.forEach((leg, k) => {
      const raw = geometry.slice(cps[k].i, cps[k + 1].i + 1);
      // Within 100 m of the start or destination there is slack: those can be on lanes the map doesn't have.
      const ends = [geometry[0], geometry[geometry.length - 1]];
      const slack = (p: [number, number]) => (ends.some((e) => haversine(p, e) < 100) ? 120 : 40);
      const fits = leg.length >= 2 && raw.every((p) => distanceToLine(p, leg) <= slack(p)) && leg.every((p) => distanceToLine(p, raw) <= slack(p));
      out.push(...(fits ? leg : raw));
    });
    return out;
  }

  /**
   * Up to three ways to make a trip, fastest first, each labelled. TomTom (with live traffic) when a key is set;
   * otherwise the free router's alternatives. `minutes` is the trip right now; `usualMin` without traffic.
   */
  async options(from: [number, number], to: [number, number], vehicle: Vehicle): Promise<RouteOption[]> {
    const key = process.env.TOMTOM_KEY;
    let list: (RouteResult & { usualMin: number; via?: string })[] = [];
    // Cycling and walking need no traffic data. TomTom's bike and foot paths often aren't on the map's roads,
    // so those trips are planned on OpenStreetMap, the same roads the map shows.
    const onMapRoads = vehicle === 'cycle' || vehicle === 'walk';
    if (onMapRoads) list = await this.osmOptions(from, to, vehicle);
    if (!list.length && key && this.quota.take('tomtom-routing')) {
      const mode = BYPASS_MODE[vehicle] ?? 'car';
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${from[1]},${from[0]}:${to[1]},${to[0]}/json?key=${key}&traffic=true&travelMode=${mode}&routeType=fastest&maxAlternatives=2&computeTravelTimeFor=all&instructionsType=text&language=en-GB`;
      type Tt = { routes: { summary: { travelTimeInSeconds: number; noTrafficTravelTimeInSeconds?: number; lengthInMeters: number }; legs: { points: { latitude: number; longitude: number }[] }[]; guidance?: { instructions: { routeOffsetInMeters: number; street?: string }[] } }[] };
      const data = await getJson<Tt>(url).catch(() => null);
      list = await Promise.all((data?.routes ?? []).map(async (r) => ({
        geometry: await this.snapToMap(r.legs.flatMap((l) => l.points.map((p) => [p.longitude, p.latitude] as [number, number])), vehicle),
        minutes: tripMinutes(vehicle, r.summary.travelTimeInSeconds, r.summary.lengthInMeters),
        usualMin: tripMinutes(vehicle, r.summary.noTrafficTravelTimeInSeconds ?? r.summary.travelTimeInSeconds, r.summary.lengthInMeters),
        distanceKm: Math.round(r.summary.lengthInMeters / 100) / 10,
        via: mainRoad(r.guidance?.instructions ?? [], r.summary.lengthInMeters),
      })));
    }
    if (!list.length) {
      const v = VEHICLES[vehicle] ?? VEHICLES.car;
      const url = `https://routing.openstreetmap.de/${v.profile}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson&alternatives=3`;
      const data = await getJson<{ routes: { geometry: { coordinates: [number, number][] }; duration: number; distance: number }[] }>(url);
      list = (data.routes ?? []).map((r) => {
        const minutes = Math.round((r.duration / 60) * v.factor);
        return { geometry: r.geometry.coordinates, minutes, usualMin: minutes, distanceKm: Math.round(r.distance / 100) / 10 };
      });
    }
    if (!list.length) throw new ServiceUnavailableException('No route found between these places');

    // Drop near-duplicates (same length within 1%), sort fastest first, then label.
    const unique = list.filter((r, i) => list.findIndex((o) => Math.abs(o.distanceKm - r.distanceKm) <= r.distanceKm * 0.01) === i);
    unique.sort((a, b) => a.minutes - b.minutes || a.distanceKm - b.distanceKm);
    const shortest = Math.min(...unique.map((r) => r.distanceKm));
    return unique.slice(0, 3).map((r, i) => ({
      ...r,
      label: i === 0 ? 'Fastest' : r.distanceKm === shortest ? 'Shortest' : `Option ${i + 1}`,
    }));
  }

  /** Cycle and walk options on OpenStreetMap roads: Geoapify (when a key is set) and the free router's alternatives. */
  private async osmOptions(from: [number, number], to: [number, number], vehicle: Vehicle): Promise<(RouteResult & { usualMin: number })[]> {
    const v = VEHICLES[vehicle] ?? VEHICLES.car;
    const timed = (geometry: [number, number][], seconds: number, metres: number) => {
      const minutes = tripMinutes(vehicle, seconds, metres);
      return { geometry, minutes, usualMin: minutes, distanceKm: Math.round(metres / 100) / 10 };
    };
    const geoapify = async () => {
      const key = process.env.GEOAPIFY_KEY;
      if (!key || !this.quota.take('geoapify-routing')) return [];
      const mode = vehicle === 'cycle' ? 'bicycle' : 'walk';
      type Ga = { features?: { geometry: { coordinates: [number, number][][] }; properties: { distance: number; time: number } }[] };
      const data = await getJson<Ga>(`https://api.geoapify.com/v1/routing?waypoints=${from[1]},${from[0]}|${to[1]},${to[0]}&mode=${mode}&apiKey=${key}`);
      return (data.features ?? []).map((f) => timed(f.geometry.coordinates.flat(), f.properties.time, f.properties.distance));
    };
    const osrm = async () => {
      const url = `https://routing.openstreetmap.de/${v.profile}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson&alternatives=3`;
      const data = await getJson<{ routes?: { geometry: { coordinates: [number, number][] }; duration: number; distance: number }[] }>(url);
      return (data.routes ?? []).map((r) => timed(r.geometry.coordinates, r.duration * v.factor, r.distance));
    };
    const [a, b] = await Promise.all([geoapify().catch(() => []), osrm().catch(() => [])]);
    return [...a, ...b];
  }

  /** Travel time right now, with traffic, from TomTom. Returns null when there is no key or quota. */
  async live(from: [number, number], to: [number, number], vehicle: Vehicle): Promise<LiveRoute | null> {
    const key = process.env.TOMTOM_KEY;
    const mode = VEHICLES[vehicle]?.tomtom;
    if (!key || !mode || !this.quota.take('tomtom-routing')) return null;
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${from[1]},${from[0]}:${to[1]},${to[0]}/json?key=${key}&traffic=true&travelMode=${mode}&routeType=fastest`;
    const data = await getJson<{ routes: { summary: { travelTimeInSeconds: number; trafficDelayInSeconds: number } }[] }>(url);
    const s = data.routes[0].summary;
    return { minutes: Math.round(s.travelTimeInSeconds / 60), delayMin: Math.round(s.trafficDelayInSeconds / 60), live: true };
  }

  /**
   * A route around blocked spots: TomTom, live traffic on, with a small box (about 130 m each way)
   * avoided around each point. Returns null when there is no key, no quota, or no route.
   */
  async bypass(from: [number, number], to: [number, number], vehicle: Vehicle, avoid: [number, number][]): Promise<RouteResult | null> {
    const key = process.env.TOMTOM_KEY;
    const mode = BYPASS_MODE[vehicle] ?? 'car';
    if (!key || !avoid.length || !this.quota.take('tomtom-routing')) return null;
    const d = 0.0012;
    const rectangles = avoid.slice(0, 10).map(([lon, lat]) => ({
      southWestCorner: { latitude: lat - d, longitude: lon - d },
      northEastCorner: { latitude: lat + d, longitude: lon + d },
    }));
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${from[1]},${from[0]}:${to[1]},${to[0]}/json?key=${key}&traffic=true&travelMode=${mode}&routeType=fastest`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': UA() },
      body: JSON.stringify({ avoidAreas: { rectangles } }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    type Tt = { routes?: { summary: { travelTimeInSeconds: number; lengthInMeters: number }; legs: { points: { latitude: number; longitude: number }[] }[] }[] };
    const r = ((await res.json()) as Tt).routes?.[0];
    if (!r) return null;
    return {
      geometry: await this.snapToMap(r.legs.flatMap((l) => l.points.map((p) => [p.longitude, p.latitude] as [number, number])), vehicle),
      minutes: tripMinutes(vehicle, r.summary.travelTimeInSeconds, r.summary.lengthInMeters),
      distanceKm: Math.round(r.summary.lengthInMeters / 100) / 10,
    };
  }
}

/** TomTom travel modes for finding a way around a closure (every vehicle can be blocked). */
const BYPASS_MODE: Record<Vehicle, string> = { car: 'car', bike2: 'motorcycle', cycle: 'bicycle', walk: 'pedestrian' };

// ---------- Traffic incidents ----------

export interface Incident {
  id: string;
  point: [number, number];
  closure: boolean;
  delayMin: number;
  description: string;
  road: string;
}

@Injectable()
export class TrafficProvider {
  private cache = new TtlCache<Incident[]>();
  constructor(private quota: QuotaService) {}

  get enabled() {
    return !!process.env.TOMTOM_KEY;
  }

  /** Incidents in a bounding box [minLon, minLat, maxLon, maxLat]. Cached 15 minutes per box. */
  async incidents(box: [number, number, number, number]): Promise<Incident[]> {
    const key = process.env.TOMTOM_KEY;
    if (!key) return [];
    const ck = box.map((n) => n.toFixed(2)).join(',');
    const hit = this.cache.get(ck);
    if (hit) return hit;
    if (!this.quota.take('tomtom-incidents')) return [];
    const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,delay,events{description},from,to,roadNumbers}}}';
    const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${key}&bbox=${box.join(',')}&fields=${encodeURIComponent(fields)}&language=en-GB&timeValidityFilter=present`;
    type Raw = { incidents: { geometry: { type: string; coordinates: any }; properties: any }[] };
    const data = await getJson<Raw>(url);
    const list: Incident[] = (data.incidents ?? []).map((i) => {
      const c = i.geometry.type === 'Point' ? i.geometry.coordinates : i.geometry.coordinates[0];
      const p = i.properties;
      return {
        id: String(p.id),
        point: [c[0], c[1]],
        closure: p.iconCategory === 8,
        delayMin: Math.round((p.delay ?? 0) / 60),
        description: p.events?.[0]?.description ?? 'Traffic incident',
        road: [p.from, p.to].filter(Boolean).join(' → '),
      };
    });
    this.cache.set(ck, list, 15 * 60 * 1000);
    return list;
  }
}

// ---------- Weather (MET Norway) ----------

export interface Weather {
  now: { temp: number; symbol: string; humidity: number; wind: number; feels: number; uv: number; dewPoint: number };
  hourly: { time: string; temp: number; symbol: string; rainMm: number }[];
  daily: { date: string; min: number; max: number; symbol: string; rainMm: number; uvMax: number }[];
  rainSoon: { from: string; to: string } | null;
  /** Today's sunrise and sunset, local HH:mm, when known. */
  sun: { rise: string; set: string } | null;
}

/** Local HH:mm from MET's "2026-11-18T06:15+05:30". */
const hhmm = (iso?: string) => (iso && /T(\d{2}:\d{2})/.exec(iso)?.[1]) || '';

@Injectable()
export class WeatherProvider {
  private cache = new TtlCache<Weather>();

  async forecast(lat: number, lon: number): Promise<Weather> {
    // Round to ~1 km cells, as MET Norway asks, so nearby users share one cached forecast.
    const la = Math.round(lat * 100) / 100, lo = Math.round(lon * 100) / 100;
    const ck = `${la},${lo}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    type Ts = { time: string; data: { instant: { details: any }; next_1_hours?: { summary: { symbol_code: string }; details: { precipitation_amount: number } }; next_6_hours?: { summary: { symbol_code: string }; details: { precipitation_amount: number } } } };
    const data = await getJson<{ properties: { timeseries: Ts[] } }>(
      `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${la}&lon=${lo}`,
    );
    const ts = data.properties.timeseries;
    const d0 = ts[0].data;
    const hourly = ts.slice(0, 24).map((t) => ({
      time: t.time,
      temp: Math.round(t.data.instant.details.air_temperature),
      symbol: t.data.next_1_hours?.summary.symbol_code ?? t.data.next_6_hours?.summary.symbol_code ?? 'cloudy',
      rainMm: t.data.next_1_hours?.details.precipitation_amount ?? 0,
    }));
    const days = new Map<string, { min: number; max: number; symbol: string; rainMm: number; uvMax: number }>();
    for (const t of ts) {
      const date = new Date(t.time).toLocaleDateString('en-CA', { timeZone: process.env.TZ_NAME ?? 'Asia/Kolkata' });
      const temp = t.data.instant.details.air_temperature;
      const d = days.get(date) ?? { min: temp, max: temp, symbol: '', rainMm: 0, uvMax: 0 };
      d.min = Math.min(d.min, temp); d.max = Math.max(d.max, temp);
      d.uvMax = Math.max(d.uvMax, t.data.instant.details.ultraviolet_index_clear_sky ?? 0);
      if (!d.symbol && t.data.next_6_hours && new Date(t.time).getUTCHours() >= 6) d.symbol = t.data.next_6_hours.summary.symbol_code;
      d.rainMm += t.data.next_1_hours?.details.precipitation_amount ?? 0;
      days.set(date, d);
    }
    const daily = [...days.entries()].slice(0, 7).map(([date, d]) => ({
      date, min: Math.round(d.min), max: Math.round(d.max), symbol: d.symbol || 'cloudy', rainMm: Math.round(d.rainMm * 10) / 10, uvMax: Math.round(d.uvMax),
    }));
    const tz = process.env.TZ_NAME ?? 'Asia/Kolkata';
    const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+05:30';
    const sunData = await getJson<{ properties: { sunrise?: { time?: string }; sunset?: { time?: string } } }>(
      `https://api.met.no/weatherapi/sunrise/3.0/sun?lat=${la}&lon=${lo}&date=${daily[0]?.date}&offset=${encodeURIComponent(offset)}`,
    ).catch(() => null);
    const rise = hhmm(sunData?.properties.sunrise?.time), set = hhmm(sunData?.properties.sunset?.time);
    const wet = hourly.slice(0, 12).filter((h) => h.rainMm >= 0.3);
    const w: Weather = {
      now: {
        temp: Math.round(d0.instant.details.air_temperature),
        symbol: d0.next_1_hours?.summary.symbol_code ?? 'cloudy',
        humidity: Math.round(d0.instant.details.relative_humidity),
        wind: Math.round(d0.instant.details.wind_speed * 3.6),
        feels: Math.round(d0.instant.details.apparent_air_temperature ?? d0.instant.details.air_temperature),
        uv: Math.round(d0.instant.details.ultraviolet_index_clear_sky ?? 0),
        dewPoint: Math.round(d0.instant.details.dew_point_temperature ?? 0),
      },
      sun: rise && set ? { rise, set } : null,
      hourly, daily,
      rainSoon: wet.length ? { from: wet[0].time, to: wet[wet.length - 1].time } : null,
    };
    this.cache.set(ck, w, 30 * 60 * 1000);
    return w;
  }
}

// ---------- News (RSS) ----------

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  topic: string;
  published: string;
  /** Photo for the story (https), when the feed has one. */
  image?: string;
  /** A sentence or two from the feed, plain text, when it has one. Never the full article. */
  summary?: string;
  /** Extra topics a story also belongs to, e.g. 'Politics' for a political Kerala story. */
  tags?: string[];
}

/**
 * Some feeds (Janayugom's section feeds) contain a bare "&" (e.g. "Kerala & India"), which strict XML parsers reject.
 * Escape any "&" that doesn't start an entity.
 */
export function repairXml(xml: string): string {
  return xml.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

/** Plain-text summary: tags and "Read more" links removed, cut at about 280 characters on a word. */
export function summaryOf(html?: string): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<a[^>]*class="moretag"[\s\S]*?<\/a>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#x200d;|&#8203;/gi, '').replace(/\s+/g, ' ').trim();
  if (text.length < 20) return undefined;
  if (text.length <= 280) return text;
  const cut = text.slice(0, 280);
  return cut.slice(0, cut.lastIndexOf(' ') > 200 ? cut.lastIndexOf(' ') : 280) + '…';
}

/** Janayugom's section for each Kerala district (Kochi is filed under Ernakulam). */
const JANAYUGOM_DISTRICT: Record<string, string> = {
  thiruvananthapuram: 'thiruvananthapuram', trivandrum: 'thiruvananthapuram', kochi: 'ernakulam', ernakulam: 'ernakulam', cochin: 'ernakulam',
  kozhikode: 'kozhikode', calicut: 'kozhikode', thrissur: 'thrissur', kollam: 'kollam', kannur: 'kannur', alappuzha: 'alappuzha',
  kottayam: 'kottayam', palakkad: 'palakkad', malappuram: 'malappuram', pathanamthitta: 'pathanamthitta', idukki: 'idukki',
  wayanad: 'wayanad', kasaragod: 'kasaragod',
};

/** The fields rss-parser reads for images: media:content / media:thumbnail (with attributes), enclosure, or an <img> in the HTML. */
export interface FeedItemImages {
  mediaContent?: { $?: { url?: string; medium?: string; type?: string } }[];
  mediaThumbnail?: { $?: { url?: string } } | { $?: { url?: string } }[];
  enclosure?: { url?: string; type?: string };
  content?: string;
  'content:encoded'?: string;
}

/** The story's photo from a feed item: the first https image URL found, else undefined. */
export function itemImage(it: FeedItemImages): string | undefined {
  const thumbs = Array.isArray(it.mediaThumbnail) ? it.mediaThumbnail : it.mediaThumbnail ? [it.mediaThumbnail] : [];
  const candidates = [
    ...(it.mediaContent ?? []).filter((m) => !m.$?.medium || m.$.medium === 'image' || m.$?.type?.startsWith('image/')).map((m) => m.$?.url),
    ...thumbs.map((m) => m.$?.url),
    it.enclosure && (!it.enclosure.type || it.enclosure.type.startsWith('image/')) ? it.enclosure.url : undefined,
    /<img[^>]+src=["']([^"']+)["']/i.exec(it['content:encoded'] ?? it.content ?? '')?.[1],
  ];
  return candidates.map((u) => u?.trim().replace(/&amp;/g, '&')).find((u): u is string => !!u && /^https:\/\/\S+$/.test(u));
}

export type NewsLang = 'en' | 'ml';
export const NEWS_LANGS: NewsLang[] = ['en', 'ml'];
/** Topics mixed into "For you", closest to home first. Politics is drawn from Kerala and India stories, so it isn't mixed in twice. */
export const NEWS_TOPICS = ['Local', 'Kerala', 'India', 'World', 'Sports', 'Entertainment', 'Tech'];

/**
 * Words that mark a story as political, in English and Malayalam (both spellings Malayalam sites use for some
 * letters). Used to fill the Politics tab from Kerala, India, local and world news, since no Malayalam publisher
 * has a current politics feed.
 */
const POLITICS_EN = /\b(BJP|Congress|CPI\(M\)|CPI-M|CPM|CPI|LDF|UDF|NDA|IUML|AAP|DMK|election|elections|polls?|bypoll|by-election|minister|ministers|chief minister|MLA|MLAs|MP|MPs|Lok Sabha|Rajya Sabha|Assembly|Parliament|party|parties|Opposition|cabinet|Governor|Modi|Rahul Gandhi|Pinarayi|Satheesan|KPCC|candidate|manifesto|coalition|Prime Minister)\b/i;
const POLITICS_ML = [
  'മന്ത്രി', 'മുഖ്യമന്ത്രി', 'മന്ത്രിസഭ', 'കോൺഗ്രസ്', 'കോണ്‍ഗ്രസ്', 'സിപിഎം', 'സി.പി.എം', 'സിപിഐ', 'ബിജെപി', 'ബി.ജെ.പി',
  'എൽഡിഎഫ്', 'എല്‍ഡിഎഫ്', 'യുഡിഎഫ്', 'യു.ഡി.എഫ്', 'എൻഡിഎ', 'എന്‍ഡിഎ', 'തിരഞ്ഞെടുപ്പ്', 'തെരഞ്ഞെടുപ്പ്', 'എംഎൽഎ', 'എംഎല്‍എ',
  'എംപി', 'നിയമസഭ', 'പാർലമെന്റ്', 'പാര്‍ലമെന്റ്', 'പാർട്ടി', 'പാര്‍ട്ടി', 'മോദി', 'രാഹുൽ', 'രാഹുല്‍', 'പിണറായി', 'സതീശൻ', 'സതീശന്‍',
  'ഗവർണർ', 'ഗവര്‍ണര്‍', 'മുസ്ലിം ലീഗ്', 'കെപിസിസി', 'സ്ഥാനാർത്ഥി', 'സ്ഥാനാര്‍ത്ഥി', 'പ്രതിപക്ഷ', 'രാഷ്ട്രീയ',
];
export function isPolitical(title: string): boolean {
  return POLITICS_EN.test(title) || POLITICS_ML.some((w) => title.includes(w));
}

interface Feed {
  topic: string;
  source?: string;
  url: string;
  /** Used only when every other feed for the topic came back empty. */
  backup?: boolean;
}

/** Google News feeds; titles end in " - Publisher". hl/gl/ceid pick the language edition. */
const gn = (lang: NewsLang, path: string) => {
  const ed = lang === 'ml' ? 'hl=ml&gl=IN&ceid=IN:ml' : 'hl=en-IN&gl=IN&ceid=IN:en';
  return `https://news.google.com/rss/${path}${path.includes('?') ? '&' : '?'}${ed}`;
};
const gnSearch = (lang: NewsLang, q: string) => gn(lang, `search?q=${encodeURIComponent(q)}`);
const gnTopic = (lang: NewsLang, t: string) => gn(lang, `headlines/section/topic/${t}`);

/** Pick 5–10 publishers whose RSS terms allow this use before launch (see the plan). */
function feedsFor(lang: NewsLang, city: string): Feed[] {
  if (lang === 'ml') {
    return [
      { topic: 'Local', url: gnSearch('ml', `${city} when:2d`) },
      ...(JANAYUGOM_DISTRICT[city.toLowerCase()] ? [{ topic: 'Local', source: 'Janayugom', url: `https://janayugomonline.com/category/${JANAYUGOM_DISTRICT[city.toLowerCase()]}/feed/` }] : []),
      // Malayalam publishers' own feeds: they carry a photo per story (Google News doesn't).
      { topic: 'Kerala', source: 'Janayugom', url: 'https://janayugomonline.com/category/kerala/feed/' },
      { topic: 'India', source: 'Janayugom', url: 'https://janayugomonline.com/category/india/feed/' },
      { topic: 'World', source: 'Janayugom', url: 'https://janayugomonline.com/category/world/feed/' },
      { topic: 'Kerala', source: 'Mathrubhumi', url: 'https://www.mathrubhumi.com/rss/news/kerala' },
      { topic: 'Kerala', source: 'Asianet News', url: 'https://www.asianetnews.com/rss/kerala-news' },
      { topic: 'Kerala', source: 'News18 Malayalam', url: 'https://malayalam.news18.com/commonfeeds/v1/mal/rss/kerala.xml' },
      { topic: 'India', source: 'Mathrubhumi', url: 'https://www.mathrubhumi.com/rss/news/india' },
      { topic: 'India', source: 'Asianet News', url: 'https://www.asianetnews.com/rss/india-news' },
      { topic: 'India', source: 'News18 Malayalam', url: 'https://malayalam.news18.com/commonfeeds/v1/mal/rss/india.xml' },
      { topic: 'World', source: 'Mathrubhumi', url: 'https://www.mathrubhumi.com/rss/news/world' },
      { topic: 'World', source: 'News18 Malayalam', url: 'https://malayalam.news18.com/commonfeeds/v1/mal/rss/world.xml' },
      { topic: 'World', source: 'Asianet News', url: 'https://www.asianetnews.com/rss/international-news' },
      { topic: 'Tech', source: 'Mathrubhumi', url: 'https://www.mathrubhumi.com/rss/technology' },
      { topic: 'Tech', source: 'News18 Malayalam', url: 'https://malayalam.news18.com/commonfeeds/v1/mal/rss/tech.xml' },
      { topic: 'Tech', source: 'Asianet News', url: 'https://www.asianetnews.com/rss/technology' },
      { topic: 'Sports', source: 'Mathrubhumi', url: 'https://www.mathrubhumi.com/rss/sports' },
      { topic: 'Sports', source: 'Asianet News', url: 'https://www.asianetnews.com/rss/sports' },
      { topic: 'Sports', source: 'News18 Malayalam', url: 'https://malayalam.news18.com/commonfeeds/v1/mal/rss/sports.xml' },
      { topic: 'Sports', source: 'Janayugom', url: 'https://janayugomonline.com/category/sports/feed/' },
      { topic: 'Entertainment', source: 'Mathrubhumi', url: 'https://www.mathrubhumi.com/rss/movies-music' },
      { topic: 'Entertainment', source: 'Asianet News', url: 'https://www.asianetnews.com/rss/entertainment' },
      { topic: 'Entertainment', source: 'News18 Malayalam', url: 'https://malayalam.news18.com/commonfeeds/v1/mal/rss/film.xml' },
      { topic: 'Entertainment', source: 'Janayugom', url: 'https://janayugomonline.com/category/entertainment/feed/' },
      // Politics comes from Kerala and India stories (see isPolitical); Google News fills in only if too few match.
      { topic: 'Politics', url: gnSearch('ml', 'രാഷ്ട്രീയം when:2d'), backup: true },
      // If every publisher feed fails, Google News still covers Kerala (headlines only, no photos).
      { topic: 'Kerala', url: gnSearch('ml', 'കേരളം when:1d'), backup: true },
    ];
  }
  return [
    { topic: 'Local', url: gnSearch('en', `${city} Kerala when:2d`) },
    { topic: 'Kerala', source: 'The Hindu', url: 'https://www.thehindu.com/news/national/kerala/feeder/default.rss' },
    { topic: 'India', source: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
    { topic: 'World', source: 'The Hindu', url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
    { topic: 'Tech', source: 'The Hindu', url: 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss' },
    { topic: 'Sports', source: 'The Hindu', url: 'https://www.thehindu.com/sport/feeder/default.rss' },
    { topic: 'Entertainment', source: 'The Hindu', url: 'https://www.thehindu.com/entertainment/feeder/default.rss' },
    { topic: 'Politics', source: 'Indian Express', url: 'https://indianexpress.com/section/political-pulse/feed/' },
  ];
}

/** "Headline - Publisher" -> ["Headline", "Publisher"]. */
export function splitSource(title: string, fallback?: string): [string, string] {
  const i = title.lastIndexOf(' - ');
  if (fallback || i < 0) return [title.trim(), fallback ?? 'News'];
  return [title.slice(0, i).trim(), title.slice(i + 3).trim()];
}

@Injectable()
export class NewsProvider {
  private log = new Logger('News');
  private parser: Parser<object, FeedItemImages> = new Parser({
    timeout: 12000,
    headers: { 'User-Agent': 'EverydayBuddy/0.1 (news reader)' },
    customFields: { item: [['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumbnail']] as never },
  });
  private cache = new TtlCache<NewsItem[]>();
  private pending = new Map<string, Promise<NewsItem[]>>();

  /** Per language and city; refreshes at most every 30 minutes; deduplicates by link and headline. */
  async list(topic?: string, lang: NewsLang = 'en', city = 'Kochi'): Promise<NewsItem[]> {
    city = city.replace(/[^\p{L}\p{N} .-]/gu, '').slice(0, 40).trim() || 'Kochi';
    const key = `${lang}|${city.toLowerCase()}`;
    let items = this.cache.get(key);
    if (!items) {
      let p = this.pending.get(key);
      if (!p) {
        p = this.fetch(lang, city).finally(() => this.pending.delete(key));
        this.pending.set(key, p);
      }
      items = await p;
      if (items.length) this.cache.set(key, items, 30 * 60 * 1000);
    }
    if (topic && topic !== 'all') return items.filter((i) => i.topic === topic || i.tags?.includes(topic)).slice(0, 40);
    // "For you": take turns across topics, closest to home first, so local stories lead.
    const groups = NEWS_TOPICS.map((t) => items.filter((i) => i.topic === t));
    const mixed: NewsItem[] = [];
    for (let r = 0; mixed.length < 40 && groups.some((g) => g.length > r); r++) for (const g of groups) if (g[r]) mixed.push(g[r]);
    return mixed.slice(0, 40);
  }

  private async fetch(lang: NewsLang, city: string): Promise<NewsItem[]> {
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    const results = await Promise.all(
      feedsFor(lang, city).map(async (f) => {
        try {
          const res = await fetch(f.url, { headers: { 'User-Agent': 'EverydayBuddy/0.1 (news reader)' }, signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return { f, items: (await this.parser.parseString(repairXml(await res.text()))).items.slice(0, 20) };
        } catch (e) {
          this.log.warn(`Feed failed: ${f.url} (${(e as Error).message})`);
          return { f, items: [] };
        }
      }),
    );
    const hasMain = new Set(results.filter((r) => !r.f.backup && r.items.length).map((r) => r.f.topic));
    // Politics has no main feed in Malayalam: count political stories among the news topics instead.
    const politicalCount = results
      .filter((r) => ['Local', 'Kerala', 'India', 'World'].includes(r.f.topic))
      .reduce((n, r) => n + r.items.filter((it) => it.title && isPolitical(it.title)).length, 0);
    if (politicalCount >= 6) hasMain.add('Politics');
    for (const { f, items } of results) {
      if (f.backup && hasMain.has(f.topic)) continue;
      for (const it of items) {
        if (!it.link || !it.title) continue;
        const [title, source] = splitSource(it.title, f.source);
        const k = title.toLowerCase();
        if (seen.has(it.link) || seen.has(k)) continue;
        seen.add(it.link);
        seen.add(k);
        const tags = ['Local', 'Kerala', 'India', 'World'].includes(f.topic) && isPolitical(title) ? ['Politics'] : undefined;
        out.push({ tags, title, link: it.link.trim(), source, topic: f.topic, published: it.isoDate ?? new Date().toISOString(), image: itemImage(it), summary: summaryOf(it.contentSnippet ?? it.content ?? (it as { summary?: string }).summary) });
      }
    }
    const weekAgo = Date.now() - 7 * 864e5;
    return out.filter((i) => Date.parse(i.published) > weekAgo).sort((a, b) => b.published.localeCompare(a.published));
  }
}

// ---------- Place search ----------

export interface Place { name: string; detail: string; lat: number; lon: number }

@Injectable()
export class PlacesProvider {
  private countries = new TtlCache<string>();
  private results = new TtlCache<Place[]>();

  /** The country code ("in") at a point, cached per ~100 km square. Empty when unknown. */
  private async countryAt(lat: number, lon: number, key: string): Promise<string> {
    const ck = `${Math.round(lat)},${Math.round(lon)}`;
    const hit = this.countries.get(ck);
    if (hit !== undefined) return hit;
    try {
      const data = await getJson<{ features: { properties: { country_code?: string } }[] }>(
        `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lon}&apiKey=${key}`,
      );
      const cc = data.features[0]?.properties.country_code ?? '';
      this.countries.set(ck, cc, 30 * 864e5);
      return cc;
    } catch {
      return '';
    }
  }

  /**
   * Suggestions closest to home first: places within about 100 km, then the rest of the user's country,
   * then the rest of the world only when those don't give enough.
   */
  async search(q: string, lat: number, lon: number): Promise<Place[]> {
    const ck = `${q.toLowerCase()}|${lat.toFixed(1)}|${lon.toFixed(1)}`;
    const cached = this.results.get(ck);
    if (cached) return cached;
    const out = await this.lookup(q, lat, lon);
    this.results.set(ck, out, 10 * 60 * 1000);
    return out;
  }

  /** Photon (OpenStreetMap, free, no key) results with their country, biased to the user. */
  private async photon(q: string, lat: number, lon: number): Promise<(Place & { cc: string })[]> {
    const data = await getJson<{ features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] }>(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&limit=10`,
    );
    return data.features.map((f) => {
      const p = f.properties;
      return {
        name: p.name ?? p.street ?? q,
        detail: [p.street, p.district ?? p.locality, p.city, p.state].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        cc: (p.countrycode ?? '').toLowerCase(),
      };
    });
  }

  private async lookup(q: string, lat: number, lon: number): Promise<Place[]> {
    const key = process.env.GEOAPIFY_KEY;
    const here: [number, number] = [lon, lat];
    const isNear = (p: Place) => haversine([p.lon, p.lat], here) <= 100_000;
    type Ga = { features: { properties: { name?: string; formatted: string; address_line2?: string; lat: number; lon: number } }[] };
    const ask = (filter: string, limit: number): Promise<Place[]> =>
      key
        ? getJson<Ga>(`https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}${filter}&bias=proximity:${lon},${lat}&limit=${limit}&apiKey=${key}`)
            .then((d) => d.features.map(({ properties: p }) => ({ name: p.name ?? p.formatted, detail: p.address_line2 ?? p.formatted, lat: p.lat, lon: p.lon })))
            .catch(() => [])
        : Promise.resolve([]);

    const ccPromise = key
      ? this.countryAt(lat, lon, key)
      : getJson<{ features: { properties: Record<string, string> }[] }>(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`)
          .then((d) => (d.features[0]?.properties.countrycode ?? '').toLowerCase()).catch(() => '');
    // Everything that doesn't need the country starts at once.
    const osmP = this.photon(q, lat, lon).catch(() => []);
    const nearP = ask(`&filter=circle:${lon},${lat},100000`, 5);
    const cc = await ccPromise;
    const [osm, gNear, gCountry] = await Promise.all([osmP, nearP, cc ? ask(`&filter=countrycode:${cc}`, 5) : Promise.resolve([])]);

    // Tiers: near (within ~100 km), the rest of the country, then the world.
    // Within a tier the two sources take turns, so each one's best match shows near the top.
    const zip = (a: Place[], b: Place[]) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter((p): p is Place => !!p);
    const near = zip(gNear, osm.filter(isNear));
    const country = zip(gCountry, osm.filter((p) => !isNear(p) && p.cc === cc));
    let world = osm.filter((p) => !isNear(p) && p.cc !== cc) as Place[];
    if (near.length + country.length < 4 && key) world = [...(await ask('', 5)), ...world];

    // One entry per place: the same name within 300 m counts once.
    const out: Place[] = [];
    for (const p of [...near, ...country, ...world]) {
      const dup = out.some((o) => o.name.toLowerCase() === p.name.toLowerCase() && haversine([o.lon, o.lat], [p.lon, p.lat]) < 300);
      if (!dup) out.push({ name: p.name, detail: p.detail, lat: p.lat, lon: p.lon });
    }
    return out.slice(0, 8);
  }

  async reverse(lat: number, lon: number): Promise<string> {
    try {
      const data = await getJson<{ features: { properties: Record<string, string> }[] }>(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`);
      const p = data.features[0]?.properties ?? {};
      return p.name ?? p.street ?? p.district ?? 'Dropped pin';
    } catch {
      return 'Dropped pin';
    }
  }
}

// ---------- Places along a route ----------

/** What the "Along the way" chips search for, as TomTom POI categories. */
export const ALONG_KINDS = {
  petrol: { categories: '7311', query: 'petrol station' },
  food: { categories: '7315', query: 'restaurant' },
  hotels: { categories: '7314', query: 'hotel' },
  atm: { categories: '7397', query: 'atm' },
  ev: { categories: '7309', query: 'ev charging' },
} as const;
export type AlongKind = keyof typeof ALONG_KINDS;

export interface AlongPlace {
  name: string;
  lat: number;
  lon: number;
  /** Extra minutes to stop here and rejoin the route. */
  detourMin: number;
  address: string;
}

@Injectable()
export class AlongRouteProvider {
  private cache = new TtlCache<AlongPlace[]>();
  constructor(private quota: QuotaService) {}

  get enabled() {
    return !!process.env.TOMTOM_KEY;
  }

  /** Places of one kind within a 10-minute detour of the route, smallest detour first. Cached 15 minutes. */
  async search(cacheKey: string, geometry: [number, number][], kind: AlongKind): Promise<AlongPlace[]> {
    const key = process.env.TOMTOM_KEY;
    if (!key) throw new ServiceUnavailableException('Places along the route need a TomTom key on the server');
    const ck = `${cacheKey}:${kind}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    if (!this.quota.take('tomtom-search')) throw new ServiceUnavailableException('Place search is paused for this month (free allowance used)');

    // TomTom takes at most a few thousand route points; keep every nth so long routes still fit.
    const step = Math.max(1, Math.ceil(geometry.length / 1000));
    const points = geometry.filter((_, i) => i % step === 0 || i === geometry.length - 1).map(([lon, lat]) => ({ lat, lon }));
    const k = ALONG_KINDS[kind];
    const url = `https://api.tomtom.com/search/2/searchAlongRoute/${encodeURIComponent(k.query)}.json?key=${key}&maxDetourTime=600&categorySet=${k.categories}&limit=15&sortBy=detourTime`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': UA() },
      body: JSON.stringify({ route: { points } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new ServiceUnavailableException('Place search is not available right now');
    type R = { results?: { poi?: { name?: string }; position: { lat: number; lon: number }; detourTime?: number; address?: { freeformAddress?: string; streetName?: string } }[] };
    const data = (await res.json()) as R;
    const list = (data.results ?? []).filter((r) => r.poi?.name).map((r) => ({
      name: r.poi!.name!,
      lat: r.position.lat,
      lon: r.position.lon,
      // TomTom can report a slightly negative detour (the stop is on a quicker line); treat it as on the route.
      detourMin: Math.max(0, Math.round((r.detourTime ?? 0) / 60)),
      address: r.address?.streetName ?? r.address?.freeformAddress ?? '',
    }));
    this.cache.set(ck, list, 15 * 60 * 1000);
    return list;
  }
}

export const PROVIDERS = [QuotaService, RoutingProvider, TrafficProvider, WeatherProvider, NewsProvider, PlacesProvider, AlongRouteProvider];
