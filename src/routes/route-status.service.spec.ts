import type { SavedRoute } from '../common/entities.js';
import type { Incident, RouteResult } from '../providers/providers.js';
import { RouteStatusService } from './route-status.service.js';

// A straight east-west route, about 3.3 km long.
const route = {
  id: 1, userId: 1, name: 'Home → Office', vehicle: 'car', days: [1], departTime: '08:30', thresholdMin: 10,
  fromLon: 76.27, fromLat: 9.93, toLon: 76.30, toLat: 9.93,
  geometry: [[76.27, 9.93], [76.30, 9.93]], usualMin: 10, distanceKm: 3.3,
} as unknown as SavedRoute;

const closure: Incident = { id: 'c1', point: [76.285, 9.9301], closure: true, delayMin: 0, description: 'Road closed', road: 'MG Road' };
const jam: Incident = { id: 'j1', point: [76.285, 9.9301], closure: false, delayMin: 15, description: 'Queuing traffic', road: 'MG Road' };

// A detour that swings ~1 km north of the blocked point.
const detour: RouteResult = { geometry: [[76.27, 9.93], [76.285, 9.94], [76.30, 9.93]], minutes: 14, distanceKm: 4.1 };
// A "detour" that still goes through the blocked point.
const sameRoad: RouteResult = { geometry: [[76.27, 9.93], [76.30, 9.93]], minutes: 12, distanceKm: 3.3 };

function service(incidents: Incident[], alt: RouteResult | null, live = { minutes: 25, delayMin: 15, live: true }) {
  const traffic = { enabled: true, incidents: vi.fn().mockResolvedValue(incidents) };
  const routing = { live: vi.fn().mockResolvedValue(live), bypass: vi.fn().mockResolvedValue(alt) };
  return { svc: new RouteStatusService(traffic as never, routing as never), routing };
}

describe('RouteStatusService bypass', () => {
  it('offers a bypass around a closure and plans the trip on it', async () => {
    const { svc, routing } = service([closure], detour);
    const s = await svc.status(route, true);
    expect(s.state).toBe('closed');
    expect(routing.bypass).toHaveBeenCalledWith([76.27, 9.93], [76.30, 9.93], 'car', [closure.point]);
    expect(s.bypass).toMatchObject({ minutes: 14, distanceKm: 4.1, extraMin: 4 });
    expect(s.leaveBy).toBe('08:26');
    expect(s.message).toContain('Take the bypass');
  });

  it('rejects a "bypass" that still passes the closure', async () => {
    const { svc } = service([closure], sameRoad);
    const s = await svc.status(route, true);
    expect(s.bypass).toBeNull();
    expect(s.message).toContain('No way around found');
  });

  it('offers a bypass for a big delay only when it is faster', async () => {
    const faster = await service([jam], detour).svc.status(route, true);
    expect(faster.state).toBe('slow');
    expect(faster.bypass?.minutes).toBe(14);

    const slower = await service([jam], { ...detour, minutes: 30 }).svc.status(route, true);
    expect(slower.bypass).toBeNull();
  });

  it('test switch fakes a closure mid-route only when simulation is allowed', async () => {
    const { svc, routing } = service([], detour, { minutes: 10, delayMin: 0, live: true });
    process.env.ALLOW_SIMULATION = 'false';
    svc.simulateClosure(1, true);
    expect((await svc.status(route, true)).state).toBe('clear');

    process.env.ALLOW_SIMULATION = 'true';
    const on = await svc.status(route, true);
    expect(on).toMatchObject({ state: 'closed', simulated: true });
    const [[, , , [mid]]] = routing.bypass.mock.calls;
    expect(mid[0]).toBeCloseTo(76.285, 3);
    expect(mid[1]).toBeCloseTo(9.93, 3);
    expect(on.bypass?.minutes).toBe(14);

    svc.simulateClosure(1, false);
    expect(await svc.status(route, false)).toMatchObject({ state: 'clear', simulated: false });
    delete process.env.ALLOW_SIMULATION;
  });

  it('does not look for a bypass when the route is clear', async () => {
    const { svc, routing } = service([], detour, { minutes: 10, delayMin: 0, live: true });
    const s = await svc.status(route, true);
    expect(s.state).toBe('clear');
    expect(routing.bypass).not.toHaveBeenCalled();
    expect(s.bypass).toBeNull();
  });
});
