import { distanceToLine, haversine, inQuietHours, toMinutes } from './util.js';

describe('util', () => {
  it('converts HH:mm to minutes', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('08:30')).toBe(510);
  });

  it('handles quiet hours that cross midnight', () => {
    expect(inQuietHours(toMinutes('23:00'), '22:00', '07:00')).toBe(true);
    expect(inQuietHours(toMinutes('06:59'), '22:00', '07:00')).toBe(true);
    expect(inQuietHours(toMinutes('07:00'), '22:00', '07:00')).toBe(false);
    expect(inQuietHours(toMinutes('13:00'), '12:00', '14:00')).toBe(true);
  });

  it('measures distance in metres', () => {
    // About 1.11 km per 0.01 degree of latitude.
    expect(haversine([76.27, 9.93], [76.27, 9.94])).toBeGreaterThan(1100);
    expect(haversine([76.27, 9.93], [76.27, 9.94])).toBeLessThan(1120);
  });

  it('matches an incident to a route only when it is close to the line', () => {
    const line: [number, number][] = [[76.27, 9.93], [76.30, 9.93]];
    expect(distanceToLine([76.285, 9.9305], line)).toBeLessThan(120); // ~55 m off the road
    expect(distanceToLine([76.285, 9.94], line)).toBeGreaterThan(1000); // ~1.1 km away
  });
});

describe('mainRoad', () => {
  it('picks the street a route spends most distance on', async () => {
    const { mainRoad } = await import('../providers/providers.js');
    const ins = [
      { routeOffsetInMeters: 0, street: 'Start Lane' },
      { routeOffsetInMeters: 100, street: 'Thenmala Road' },
      { routeOffsetInMeters: 2200, street: 'Gokul Road' },
      { routeOffsetInMeters: 2500, street: 'M C Road' },
    ];
    expect(mainRoad(ins, 4000)).toBe('Thenmala Road');
    expect(mainRoad([], 4000)).toBeUndefined();
  });
});

import { splitSource } from '../providers/providers.js';

describe('splitSource', () => {
  it('splits a Google News headline into title and publisher', () => {
    expect(splitSource('മഴ ശക്തമാകും - Manorama Online')).toEqual(['മഴ ശക്തമാകും', 'Manorama Online']);
  });
  it('keeps the title whole when the feed names its source', () => {
    expect(splitSource('Kochi - Metro update', 'The Hindu')).toEqual(['Kochi - Metro update', 'The Hindu']);
  });
});

import { checkpoints, tripMinutes } from '../providers/providers.js';

describe('tripMinutes', () => {
  it('times cycling from distance, not from car traffic', () => {
    // TomTom's bicycle mode said 22 min for 7.1 km (car speed); at 15 km/h it is 28 min.
    expect(tripMinutes('cycle', 22 * 60, 7100)).toBe(28);
    expect(tripMinutes('car', 22 * 60, 7400)).toBe(22);
  });
});

describe('checkpoints', () => {
  it('spaces points along a path and always keeps both ends', () => {
    const line: [number, number][] = Array.from({ length: 101 }, (_, i) => [76.2 + i * 0.0001, 9.9]); // ~1.1 km east
    const cps = checkpoints(line, 250, 60);
    expect(cps[0].i).toBe(0);
    expect(cps.at(-1)!.i).toBe(100);
    expect(cps.length).toBeGreaterThanOrEqual(4);
    expect(cps.length).toBeLessThanOrEqual(6);
    expect(cps[1].heading).toBe(90);
  });
  it('never returns more than the maximum', () => {
    const line: [number, number][] = Array.from({ length: 2000 }, (_, i) => [76.2 + i * 0.001, 9.9]);
    expect(checkpoints(line, 250, 60).length).toBeLessThanOrEqual(60);
  });
});
