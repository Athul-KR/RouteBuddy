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
}

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

/** Pick 5–10 publishers whose RSS terms allow this use before launch (see the plan). */
const FEEDS: { topic: string; source: string; url: string }[] = [
  { topic: 'Local', source: 'The Hindu', url: 'https://www.thehindu.com/news/national/kerala/feeder/default.rss' },
  { topic: 'India', source: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { topic: 'World', source: 'The Hindu', url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
  { topic: 'Tech', source: 'The Hindu', url: 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss' },
];

@Injectable()
export class NewsProvider {
  private log = new Logger('News');
  private parser = new Parser({ timeout: 12000, headers: { 'User-Agent': 'EverydayBuddy/0.1' } });
  private items: NewsItem[] = [];
  private fetchedAt = 0;

  /** Refreshes at most every 30 minutes; deduplicates by link. */
  async list(topic?: string): Promise<NewsItem[]> {
    if (Date.now() - this.fetchedAt > 30 * 60 * 1000) await this.refresh();
    const all = topic && topic !== 'all' ? this.items.filter((i) => i.topic === topic) : this.items;
    return all.slice(0, 40);
  }

  async refresh() {
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    await Promise.all(
      FEEDS.map(async (f) => {
        try {
          const feed = await this.parser.parseURL(f.url);
          for (const it of feed.items.slice(0, 20)) {
            if (!it.link || !it.title || seen.has(it.link)) continue;
            seen.add(it.link);
            out.push({ title: it.title.trim(), link: it.link, source: f.source, topic: f.topic, published: it.isoDate ?? new Date().toISOString() });
          }
        } catch (e) {
          this.log.warn(`Feed failed: ${f.url} (${(e as Error).message})`);
        }
      }),
    );
    if (out.length) {
      const weekAgo = Date.now() - 7 * 864e5;
      this.items = out.filter((i) => Date.parse(i.published) > weekAgo).sort((a, b) => b.published.localeCompare(a.published));
      this.fetchedAt = Date.now();
    }
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

export const PROVIDERS = [QuotaService, RoutingProvider, TrafficProvider, WeatherProvider, NewsProvider, PlacesProvider];
