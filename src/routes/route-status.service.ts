import { Injectable } from '@nestjs/common';
import { SavedRoute } from '../common/entities.js';
import { bbox, distanceToLine, localParts, toMinutes, TtlCache } from '../common/util.js';
import { Incident, RoutingProvider, TrafficProvider } from '../providers/providers.js';

export interface RouteStatus {
  routeId: number;
  state: 'clear' | 'slow' | 'closed' | 'unknown';
  live: boolean;
  usualMin: number;
  nowMin: number;
  delayMin: number;
  leaveBy: string;
  incidents: Incident[];
  message: string;
  checkedAt: string;
}

/** An incident counts when it is within this many metres of the route line. */
const MATCH_METRES = 120;

@Injectable()
export class RouteStatusService {
  private cache = new TtlCache<RouteStatus>();
  constructor(private traffic: TrafficProvider, private routing: RoutingProvider) {}

  async status(r: SavedRoute, force = false): Promise<RouteStatus> {
    const ck = `${r.id}:${r.vehicle}:${r.departTime}`;
    if (!force) {
      const hit = this.cache.get(ck);
      if (hit) return hit;
    }
    const all = await this.traffic.incidents(bbox(r.geometry));
    const incidents = all.filter((i) => distanceToLine(i.point, r.geometry) <= MATCH_METRES);
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

    const leave = toMinutes(r.departTime) - Math.max(0, delayMin);
    const leaveBy = `${String(Math.floor(((leave + 1440) % 1440) / 60)).padStart(2, '0')}:${String((leave + 1440) % 60).padStart(2, '0')}`;
    const first = incidents.find((i) => i.closure) ?? incidents[0];
    const message =
      state === 'unknown' ? 'Live traffic is off. Add a TomTom key to the API to switch it on.'
      : state === 'closed' ? `Closure: ${first.description}${first.road ? ` on ${first.road}` : ''}. Expect ${nowMin} min; leave by ${leaveBy}.`
      : state === 'slow' ? `${delayMin} min slower than usual. Leave by ${leaveBy}.`
      : `Clear. About ${nowMin} min.`;

    const s: RouteStatus = {
      routeId: r.id, state, live, usualMin: r.usualMin, nowMin: Math.max(nowMin, r.usualMin + delayMin), delayMin,
      leaveBy, incidents, message, checkedAt: new Date().toISOString(),
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
