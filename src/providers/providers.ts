import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Parser from 'rss-parser';
import type { Vehicle } from '../common/entities.js';
import { TtlCache } from '../common/util.js';
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

  /**
   * Up to three ways to make a trip, fastest first, each labelled. TomTom (with live traffic) when a key is set;
   * otherwise the free router's alternatives. `minutes` is the trip right now; `usualMin` without traffic.
   */
  async options(from: [number, number], to: [number, number], vehicle: Vehicle): Promise<RouteOption[]> {
    const key = process.env.TOMTOM_KEY;
    let list: (RouteResult & { usualMin: number; via?: string })[] = [];
    if (key && this.quota.take('tomtom-routing')) {
      const mode = BYPASS_MODE[vehicle] ?? 'car';
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${from[1]},${from[0]}:${to[1]},${to[0]}/json?key=${key}&traffic=true&travelMode=${mode}&routeType=fastest&maxAlternatives=2&computeTravelTimeFor=all&instructionsType=text&language=en-GB`;
      type Tt = { routes: { summary: { travelTimeInSeconds: number; noTrafficTravelTimeInSeconds?: number; lengthInMeters: number }; legs: { points: { latitude: number; longitude: number }[] }[]; guidance?: { instructions: { routeOffsetInMeters: number; street?: string }[] } }[] };
      const data = await getJson<Tt>(url).catch(() => null);
      list = (data?.routes ?? []).map((r) => ({
        geometry: r.legs.flatMap((l) => l.points.map((p) => [p.longitude, p.latitude] as [number, number])),
        minutes: Math.round(r.summary.travelTimeInSeconds / 60),
        usualMin: Math.round((r.summary.noTrafficTravelTimeInSeconds ?? r.summary.travelTimeInSeconds) / 60),
        distanceKm: Math.round(r.summary.lengthInMeters / 100) / 10,
        via: mainRoad(r.guidance?.instructions ?? [], r.summary.lengthInMeters),
      }));
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
      geometry: r.legs.flatMap((l) => l.points.map((p) => [p.longitude, p.latitude] as [number, number])),
      minutes: Math.round(r.summary.travelTimeInSeconds / 60),
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
  now: { temp: number; symbol: string; humidity: number; wind: number };
  hourly: { time: string; temp: number; symbol: string; rainMm: number }[];
  daily: { date: string; min: number; max: number; symbol: string; rainMm: number }[];
  rainSoon: { from: string; to: string } | null;
}

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
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${la}&lon=${lo}`,
    );
    const ts = data.properties.timeseries;
    const d0 = ts[0].data;
    const hourly = ts.slice(0, 24).map((t) => ({
      time: t.time,
      temp: Math.round(t.data.instant.details.air_temperature),
      symbol: t.data.next_1_hours?.summary.symbol_code ?? t.data.next_6_hours?.summary.symbol_code ?? 'cloudy',
      rainMm: t.data.next_1_hours?.details.precipitation_amount ?? 0,
    }));
    const days = new Map<string, { min: number; max: number; symbol: string; rainMm: number }>();
    for (const t of ts) {
      const date = new Date(t.time).toLocaleDateString('en-CA', { timeZone: process.env.TZ_NAME ?? 'Asia/Kolkata' });
      const temp = t.data.instant.details.air_temperature;
      const d = days.get(date) ?? { min: temp, max: temp, symbol: '', rainMm: 0 };
      d.min = Math.min(d.min, temp); d.max = Math.max(d.max, temp);
      if (!d.symbol && t.data.next_6_hours && new Date(t.time).getUTCHours() >= 6) d.symbol = t.data.next_6_hours.summary.symbol_code;
      d.rainMm += t.data.next_1_hours?.details.precipitation_amount ?? 0;
      days.set(date, d);
    }
    const daily = [...days.entries()].slice(0, 7).map(([date, d]) => ({
      date, min: Math.round(d.min), max: Math.round(d.max), symbol: d.symbol || 'cloudy', rainMm: Math.round(d.rainMm * 10) / 10,
    }));
    const wet = hourly.slice(0, 12).filter((h) => h.rainMm >= 0.3);
    const w: Weather = {
      now: {
        temp: Math.round(d0.instant.details.air_temperature),
        symbol: d0.next_1_hours?.summary.symbol_code ?? 'cloudy',
        humidity: Math.round(d0.instant.details.relative_humidity),
        wind: Math.round(d0.instant.details.wind_speed * 3.6),
      },
      hourly, daily,
      rainSoon: wet.length ? { from: wet[0].time, to: wet[wet.length - 1].time } : null,
    };
    this.cache.set(ck, w, 30 * 60 * 1000);
    return w;
  }
}

// ---------- News (RSS) ----------

export interface NewsItem { title: string; link: string; source: string; topic: string; published: string }

export type NewsLang = 'en' | 'ml';
export const NEWS_LANGS: NewsLang[] = ['en', 'ml'];
export const NEWS_TOPICS = ['Local', 'Kerala', 'India', 'World', 'Tech'];

interface Feed { topic: string; source?: string; url: string }

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
      { topic: 'Kerala', url: gnSearch('ml', 'കേരളം when:1d') },
      { topic: 'India', url: gnTopic('ml', 'NATION') },
      { topic: 'World', url: gnTopic('ml', 'WORLD') },
      { topic: 'Tech', url: gnTopic('ml', 'TECHNOLOGY') },
    ];
  }
  return [
    { topic: 'Local', url: gnSearch('en', `${city} Kerala when:2d`) },
    { topic: 'Kerala', source: 'The Hindu', url: 'https://www.thehindu.com/news/national/kerala/feeder/default.rss' },
    { topic: 'India', source: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
    { topic: 'World', source: 'The Hindu', url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
    { topic: 'Tech', source: 'The Hindu', url: 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss' },
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
  private parser = new Parser({ timeout: 12000, headers: { 'User-Agent': 'EverydayBuddy/0.1' } });
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
    if (topic && topic !== 'all') return items.filter((i) => i.topic === topic).slice(0, 40);
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
          return { f, items: (await this.parser.parseURL(f.url)).items.slice(0, 20) };
        } catch (e) {
          this.log.warn(`Feed failed: ${f.url} (${(e as Error).message})`);
          return { f, items: [] };
        }
      }),
    );
    for (const { f, items } of results) {
      for (const it of items) {
        if (!it.link || !it.title) continue;
        const [title, source] = splitSource(it.title, f.source);
        const k = title.toLowerCase();
        if (seen.has(it.link) || seen.has(k)) continue;
        seen.add(it.link);
        seen.add(k);
        out.push({ title, link: it.link, source, topic: f.topic, published: it.isoDate ?? new Date().toISOString() });
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
  async search(q: string, lat: number, lon: number): Promise<Place[]> {
    const key = process.env.GEOAPIFY_KEY;
    if (key) {
      const data = await getJson<{ features: { properties: { name?: string; formatted: string; address_line2?: string; lat: number; lon: number } }[] }>(
        `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}&bias=proximity:${lon},${lat}&limit=6&apiKey=${key}`,
      );
      return data.features.map(({ properties: p }) => ({ name: p.name ?? p.formatted, detail: p.address_line2 ?? p.formatted, lat: p.lat, lon: p.lon }));
    }
    // Free fallback: Photon (OpenStreetMap data), no key needed. Fine for a demo, not for production traffic.
    const data = await getJson<{ features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] }>(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&limit=6`,
    );
    return data.features.map((f) => {
      const p = f.properties;
      return {
        name: p.name ?? p.street ?? q,
        detail: [p.street, p.district ?? p.locality, p.city, p.state].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
      };
    });
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
