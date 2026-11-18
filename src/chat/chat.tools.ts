import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { Repository } from 'typeorm';
import { DEFAULT_SETTINGS, type Reminder, type SavedRoute, type User, type Vehicle, type WaterLog } from '../common/entities.js';
import { waterSummary } from '../reminders/water.js';
import { today } from '../common/util.js';
import type { Place, PlacesProvider, RoutingProvider } from '../providers/providers.js';

/** What a chat turn changed, so the app can refresh those screens. */
export type Changed = 'water' | 'reminders' | 'routes';

export interface ToolDeps {
  user: User;
  water: Repository<WaterLog>;
  reminders: Repository<Reminder>;
  routes: Repository<SavedRoute>;
  places: PlacesProvider;
  routing: RoutingProvider;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VEHICLE_NAMES: Record<Vehicle, string> = { car: 'car', bike2: 'two-wheeler', cycle: 'cycle', walk: 'walking' };

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * The place a user means by "Kaloor, Kochi" or "Infopark Kakkanad". The search can rank a shop or office that only
 * mentions the town above the area itself, so both the full text and the part before the comma are searched, and a
 * result whose name matches what the user said wins; otherwise the search's own first result (closest to home).
 */
export async function findPlace(d: Pick<ToolDeps, 'places' | 'user'>, text: string): Promise<Place | undefined> {
  const full = text.trim();
  const head = full.split(',')[0].trim();
  const queries = [...new Set([head, full].filter((q) => q.length >= 2))];
  const lists = await Promise.all(queries.map((q) => d.places.search(q, d.user.lat, d.user.lon).catch(() => [] as Place[])));
  const all = lists.flat();
  if (!all.length) return undefined;
  const want = norm(head);
  const score = (p: Place) => {
    const n = norm(p.name);
    if (n === want) return 3;
    if (n.startsWith(want) || want.startsWith(n)) return 2;
    if (n.includes(want) || norm(p.detail).includes(want)) return 1;
    return 0;
  };
  // Highest score; ties keep the search order (closest to home first).
  return all.reduce((best, p) => (score(p) > score(best) ? p : best), all[0]);
}

/**
 * The actions Buddy can take. Each tool checks its input again (the model's input is untrusted),
 * acts only on the signed-in user's data, and records what it changed in `changed`.
 */
export function chatTools(d: ToolDeps, changed: Set<Changed>) {
  const userId = d.user.id;

  const logWater = betaTool({
    name: 'log_water',
    description:
      'Log water the user drank today, in millilitres. A cup is 150 ml, a glass 250 ml, a bottle 500 ml. ' +
      'Use when the user says they drank water or asks to log it.',
    strict: true,
    inputSchema: {
      type: 'object',
      properties: { ml: { type: 'integer', description: 'Millilitres, 50 to 3000. 250 (one glass) if the user did not say.' } },
      required: ['ml'],
      additionalProperties: false,
    },
    run: async ({ ml }) => {
      if (!Number.isInteger(ml) || ml < 50 || ml > 3000) return 'Error: ml must be a whole number from 50 to 3000.';
      const date = today();
      // Each entry holds at most 1,500 ml, so a large amount is split into a few entries.
      const parts: number[] = [];
      for (let left = ml; left > 0; left -= 1500) parts.push(Math.min(1500, left));
      await d.water.save(parts.map((p) => d.water.create({ userId, date, ml: p })));
      changed.add('water');
      const w = await waterSummary(d.water, userId, { ...DEFAULT_SETTINGS, ...d.user.settings }.waterGoalMl);
      return `Logged ${ml} ml. Total today: ${w.ml} ml of ${w.goalMl} ml.`;
    },
  });

  const addReminder = betaTool({
    name: 'add_reminder',
    description:
      'Add a reminder to the user\'s schedule. Use for "remind me to...", "add ... to my plan", appointments and tasks. ' +
      'Repeat "daily" for every-day habits; otherwise "once" on a date (today unless the user named another day).',
    strict: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Call mom". In the language the user used.' },
        time: { type: 'string', description: '24-hour time HH:mm, India time.' },
        repeat: { type: 'string', enum: ['once', 'daily'] },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Medium unless the user says it is important (high) or minor (low).' },
        note: { type: 'string', description: 'Extra detail the user gave, or an empty string.' },
        date: { type: 'string', description: 'YYYY-MM-DD for a one-off reminder. For daily reminders, today\'s date.' },
      },
      required: ['title', 'time', 'repeat', 'date', 'priority', 'note'],
      additionalProperties: false,
    },
    run: async ({ title, time, repeat, date, priority, note }) => {
      const t = title.trim().slice(0, 120);
      if (!t) return 'Error: the reminder needs a title.';
      if (!HHMM.test(time)) return 'Error: time must be HH:mm in 24-hour format, e.g. 18:30.';
      if (repeat === 'once' && (!DATE.test(date) || date < today())) return `Error: date must be YYYY-MM-DD, today (${today()}) or later.`;
      const r = await d.reminders.save(
        d.reminders.create({ userId, title: t, time, repeat, date: repeat === 'once' ? date : undefined, priority, note: note.trim().slice(0, 500) || null }),
      );
      changed.add('reminders');
      return `Added reminder "${r.title}" at ${r.time}, ${repeat === 'daily' ? 'every day' : `on ${date}`}.`;
    },
  });

  const addRoute = betaTool({
    name: 'add_route',
    description:
      'Save a regular trip (commute) so the app watches its traffic and alerts the user before leaving. ' +
      'Needs real place names for both ends: a locality, landmark or address, not "home" or "office" alone. ' +
      'If the user has not said where they start, where they go, or when they leave, ask before calling this.',
    strict: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "Office". Empty string to name it after the places.' },
        from: { type: 'string', description: 'Start place as the user said it, with the town if known, e.g. "Kaloor, Kochi".' },
        to: { type: 'string', description: 'Destination as the user said it, with the town if known, e.g. "Infopark, Kakkanad".' },
        depart_time: { type: 'string', description: '24-hour time HH:mm the user leaves.' },
        days: { type: 'array', items: { type: 'integer' }, description: 'Days of the week the trip happens, 0 = Sunday ... 6 = Saturday. Monday to Friday if the user did not say.' },
        vehicle: { type: 'string', enum: ['car', 'bike2', 'cycle', 'walk'], description: 'bike2 is a two-wheeler (scooter or motorbike). Car if the user did not say.' },
      },
      required: ['name', 'from', 'to', 'depart_time', 'days', 'vehicle'],
      additionalProperties: false,
    },
    run: async ({ name, from, to, depart_time, days, vehicle }) => {
      if (!HHMM.test(depart_time)) return 'Error: depart_time must be HH:mm in 24-hour format.';
      const dayList = [...new Set(days)].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6).sort();
      if (!dayList.length) return 'Error: give at least one day, 0 = Sunday ... 6 = Saturday.';
      if (!(vehicle in VEHICLE_NAMES)) return 'Error: unknown vehicle.';
      if ((await d.routes.countBy({ userId })) >= 20) return 'Error: the user already has 20 saved routes. Ask them to delete one in Routes first.';

      const [a, b] = await Promise.all([findPlace(d, from), findPlace(d, to)]);
      if (!a) return `Error: couldn't find "${from}". Ask the user for a nearby landmark or the area name.`;
      if (!b) return `Error: couldn't find "${to}". Ask the user for a nearby landmark or the area name.`;

      const v = vehicle as Vehicle;
      const options = await d.routing.options([a.lon, a.lat], [b.lon, b.lat], v).catch(() => []);
      const best = options[0];
      if (!best) return `Error: no ${VEHICLE_NAMES[v]} route found between ${a.name} and ${b.name}.`;

      const r = await d.routes.save(
        d.routes.create({
          userId,
          name: name.trim().slice(0, 60) || `${a.name} → ${b.name}`,
          fromName: a.name, fromLat: a.lat, fromLon: a.lon,
          toName: b.name, toLat: b.lat, toLon: b.lon,
          vehicle: v, days: dayList, departTime: depart_time, thresholdMin: 10,
          geometry: best.geometry, usualMin: best.minutes, distanceKm: best.distanceKm,
        }),
      );
      changed.add('routes');
      return (
        `Saved route "${r.name}": from ${a.name} (${a.detail}) to ${b.name} (${b.detail}), ` +
        `${best.distanceKm} km by ${VEHICLE_NAMES[v]}, about ${best.minutes} min${best.via ? ` via ${best.via}` : ''}, ` +
        `leaving ${depart_time} on ${dayList.map((x) => DAY_NAMES[x]).join(', ')}. ` +
        'Tell the user which places were matched, so they can check them; they can change or delete it in Routes.'
      );
    },
  });

  return [logWater, addReminder, addRoute];
}
