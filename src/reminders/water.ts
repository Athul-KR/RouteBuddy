import { MoreThanOrEqual, type Repository } from 'typeorm';
import type { WaterLog } from '../common/entities.js';
import { today } from '../common/util.js';

/** The calendar date `n` days before `date` (both YYYY-MM-DD). */
export function daysBefore(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface WaterSummary {
  date: string;
  /** Drinks logged today. */
  count: number;
  /** Millilitres today. */
  ml: number;
  goalMl: number;
  last: { ml: number; at: Date } | null;
  /** The last 7 days, oldest first, today last. */
  history: { date: string; ml: number }[];
  /** Days in a row the goal was met, counting today only once it's met. */
  streak: number;
}

/** Today's water, the week before it, and the streak, from the user's logs of the last 30 days. */
export async function waterSummary(water: Repository<WaterLog>, userId: number, goalMl: number): Promise<WaterSummary> {
  const d = today();
  const logs = await water.find({ where: { userId, date: MoreThanOrEqual(daysBefore(d, 30)) }, order: { id: 'ASC' } });
  const byDay = new Map<string, number>();
  for (const l of logs) byDay.set(l.date, (byDay.get(l.date) ?? 0) + (l.ml ?? 250));
  const todays = logs.filter((l) => l.date === d);
  const last = todays[todays.length - 1];
  const ml = byDay.get(d) ?? 0;
  let streak = ml >= goalMl ? 1 : 0;
  for (let i = 1; i <= 30 && (byDay.get(daysBefore(d, i)) ?? 0) >= goalMl; i++) streak++;
  return {
    date: d,
    count: todays.length,
    ml,
    goalMl,
    last: last ? { ml: last.ml ?? 250, at: last.createdAt } : null,
    history: Array.from({ length: 7 }, (_, i) => {
      const day = daysBefore(d, 6 - i);
      return { date: day, ml: byDay.get(day) ?? 0 };
    }),
    streak,
  };
}
