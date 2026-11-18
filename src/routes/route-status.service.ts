import { Injectable } from '@nestjs/common';
import { SavedRoute } from '../common/entities.js';
import { bbox, distanceToLine, localParts, pointAlong, toMinutes, TtlCache } from '../common/util.js';
import { Incident, RoutingProvider, TrafficProvider } from '../providers/providers.js';

export interface RouteStatus {
  routeId: number;
  state: 'clear' | 'slow' | 'closed' | 'unknown';
  live: boolean;
  /** True while a test closure is switched on. */
  simulated: boolean;
  usualMin: number;
  nowMin: number;
  delayMin: number;
  leaveBy: string;
  incidents: Incident[];
  /** A route around the closure or delay, when one exists. */
  bypass: Bypass | null;
  message: string;
  checkedAt: string;
}

export interface Bypass {
  /** [lon, lat] pairs */
  geometry: [number, number][];
  minutes: number;
  distanceKm: number;
  /** Minutes more than the usual trip. */
  extraMin: number;
}

/** An incident counts when it is within this many metres of the route line. */
const MATCH_METRES = 120;

@Injectable()
export class RouteStatusService {
  private cache = new TtlCache<RouteStatus>();
  /** Test mode: route id -> when its simulated closure ends. Only used when ALLOW_SIMULATION=true. */
  private simulated = new Map<number, number>();

  static get simulationAllowed() {
    return process.env.ALLOW_SIMULATION === 'true';
  }

  /** Turns a fake closure on or off for a route (30 minutes). Everything else, including the bypass, stays real. */
  simulateClosure(routeId: number, on: boolean) {
    if (on) this.simulated.set(routeId, Date.now() + 30 * 60 * 1000);
    else this.simulated.delete(routeId);
    this.cache.deletePrefix(`${routeId}:`);
  }

  private isSimulated(routeId: number) {
    const until = this.simulated.get(routeId);
    if (!until || !RouteStatusService.simulationAllowed) return false;
    if (until < Date.now()) { this.simulated.delete(routeId); return false; }
    return true;
  }
  constructor(private traffic: TrafficProvider, private routing: RoutingProvider) {}

  async status(r: SavedRoute, force = false): Promise<RouteStatus> {
    const ck = `${r.id}:${r.vehicle}:${r.departTime}`;
    if (!force) {
      const hit = this.cache.get(ck);
      if (hit) return hit;
    }
    const all = await this.traffic.incidents(bbox(r.geometry));
    const incidents = all.filter((i) => distanceToLine(i.point, r.geometry) <= MATCH_METRES);
    const simulated = this.isSimulated(r.id);
    if (simulated) {
      const mid = pointAlong(r.geometry, 0.5);
      incidents.push({ id: 'simulated', point: mid, closure: true, delayMin: 0, description: 'Road closed (test)', road: 'simulated closure' });
    }
    const closure = incidents.some((i) => i.closure);

    let nowMin = r.usualMin;
    let delayMin = 0;
    let live = false;
    if (this.traffic.enabled && (incidents.length || force)) {
      const l = await this.routing.live([r.fromLon, r.fromLat], [r.toLon, r.toLat], r.vehicle).catch(() => null);
      if (l) { live = true; delayMin = l.delayMin; nowMin = Math.max(r.usualMin, l.minutes); }
    } else if (this.traffic.enabled) {
      live = true;
    }
    if (!live) delayMin = incidents.reduce((s, i) => s + i.delayMin, 0);

    const state: RouteStatus['state'] = !this.traffic.enabled
      ? 'unknown'
      : closure ? 'closed' : delayMin >= r.thresholdMin ? 'slow' : 'clear';
    nowMin = Math.max(nowMin, r.usualMin + delayMin);

    // Look for a way around a closure, or around the incidents behind a big delay.
    let bypass: Bypass | null = null;
    if (state === 'closed' || state === 'slow') {
      const blocked = (state === 'closed' ? incidents.filter((i) => i.closure) : incidents).map((i) => i.point);
      const alt = await this.routing.bypass([r.fromLon, r.fromLat], [r.toLon, r.toLat], r.vehicle, blocked).catch(() => null);
      // Keep it only if it really avoids every blocked point, and, for a delay, only if it is faster.
      const clearOfBlocks = alt && blocked.every((p) => distanceToLine(p, alt.geometry) > MATCH_METRES);
      if (alt && clearOfBlocks && (state === 'closed' || alt.minutes < nowMin)) {
        bypass = { ...alt, extraMin: Math.max(0, alt.minutes - r.usualMin) };
      }
    }

    // With a bypass, plan the trip on the bypass time.
    const extra = bypass ? bypass.extraMin : Math.max(0, delayMin);
    const leave = toMinutes(r.departTime) - extra;
    const leaveBy = `${String(Math.floor(((leave + 1440) % 1440) / 60)).padStart(2, '0')}:${String((leave + 1440) % 60).padStart(2, '0')}`;
    const first = incidents.find((i) => i.closure) ?? incidents[0];
    const where = first ? `${first.description}${first.road ? ` on ${first.road}` : ''}` : '';
    const message =
      state === 'unknown' ? 'Live traffic is off. Add a TomTom key to the API to switch it on.'
      : state === 'closed' && bypass ? `Closure: ${where}. Take the bypass: ${bypass.minutes} min, ${bypass.distanceKm} km. Leave by ${leaveBy}.`
      : state === 'closed' ? `Closure: ${where}. No way around found; check before you leave.`
      : state === 'slow' && bypass ? `${delayMin} min slower than usual. A bypass takes ${bypass.minutes} min instead of ${nowMin}. Leave by ${leaveBy}.`
      : state === 'slow' ? `${delayMin} min slower than usual. Leave by ${leaveBy}.`
      : `Clear. About ${nowMin} min.`;

    const s: RouteStatus = {
      routeId: r.id, state, live, simulated, usualMin: r.usualMin, nowMin, delayMin,
      leaveBy, incidents, bypass, message, checkedAt: new Date().toISOString(),
    };
    this.cache.set(ck, s, 10 * 60 * 1000);
    return s;
  }

  /** The next scheduled trip today, if any, and minutes until it. */
  nextTrip(routes: SavedRoute[]): { route: SavedRoute; inMin: number } | null {
    const now = localParts();
    const upcoming = routes
      .filter((r) => r.days.includes(now.weekday))
      .map((r) => ({ route: r, inMin: toMinutes(r.departTime) - now.minutes }))
      .filter((x) => x.inMin > -30)
      .sort((a, b) => a.inMin - b.inMin);
    return upcoming[0] ?? (routes[0] ? { route: routes[0], inMin: Infinity } : null);
  }
}
