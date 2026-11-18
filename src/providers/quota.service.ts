import { Injectable, Logger } from '@nestjs/common';

/**
 * Counts calls per provider per month and stops at 90% of the free allowance.
 * In-memory for the demo; move to Redis (as in the plan) for production.
 */
const LIMITS: Record<string, number> = {
  get 'tomtom-incidents'() { return Number(process.env.TOMTOM_INCIDENT_LIMIT ?? 2500); },
  get 'tomtom-routing'() { return Number(process.env.TOMTOM_ROUTING_LIMIT ?? 20000); },
  get 'tomtom-search'() { return Number(process.env.TOMTOM_SEARCH_LIMIT ?? 2500); },
  // Geoapify's free plan is 3,000 credits a day.
  get 'geoapify-routing'() { return Number(process.env.GEOAPIFY_ROUTING_LIMIT ?? 60000); },
};

@Injectable()
export class QuotaService {
  private log = new Logger('Quota');
  private counts = new Map<string, number>();

  private key(provider: string) {
    const d = new Date();
    return `${provider}:${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
  }

  /** Returns false (and logs) if the provider is at its stop limit. */
  take(provider: string): boolean {
    const limit = LIMITS[provider];
    if (!limit) return true;
    const k = this.key(provider);
    const used = this.counts.get(k) ?? 0;
    if (used >= limit * 0.9) {
      this.log.warn(`${provider} stopped at ${used}/${limit} calls this month`);
      return false;
    }
    this.counts.set(k, used + 1);
    if (used + 1 === Math.floor(limit * 0.8)) this.log.warn(`${provider} passed 80% of its allowance`);
    return true;
  }

  report() {
    return Object.keys(LIMITS).map((p) => ({ provider: p, used: this.counts.get(this.key(p)) ?? 0, limit: LIMITS[p] }));
  }
}
