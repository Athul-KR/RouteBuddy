import { findPlace } from './chat.tools.js';
import type { Place } from '../providers/providers.js';
import type { User } from '../common/entities.js';

const place = (name: string, detail = ''): Place => ({ name, detail, lat: 9.99, lon: 76.3 });
const user = { lat: 9.93, lon: 76.27 } as User;
const fakePlaces = (results: Record<string, Place[]>) => ({ search: async (q: string) => results[q] ?? [] }) as never;

describe('findPlace', () => {
  it('prefers the area the user named over an office that only mentions the town', async () => {
    const places = fakePlaces({
      'Kaloor, Kochi': [place('Office of The Executive Engineer, Water Supply Division, Kochi-18'), place('Kaloor Mini Tower')],
      Kaloor: [place('Kaloor', 'Ernakulam, KL, India'), place('Kaloor-Kadavanthra Road')],
    });
    expect((await findPlace({ places, user }, 'Kaloor, Kochi'))?.name).toBe('Kaloor');
  });
  it('falls back to the first result when nothing matches by name', async () => {
    const places = fakePlaces({ 'my office': [place('Infopark Phase 1'), place('Smart City')] });
    expect((await findPlace({ places, user }, 'my office'))?.name).toBe('Infopark Phase 1');
  });
  it('returns nothing when the search finds nothing', async () => {
    expect(await findPlace({ places: fakePlaces({}), user }, 'Nowhere')).toBeUndefined();
  });
});
