export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<unknown>;
}

export type OperationPriority = 'HIGH_FULFILLMENT' | 'LOW_BACKGROUND_POLL';

/**
 * Header-Aware Dynamic Quota Throttler for Yalidine / Guepex APIs.
 * - Uses strict TTLs (EX 60, EX 3600, EX 86400) so paused accounts auto-recover when windows reset.
 * - Tracks rolling peak quota per window to compute true percentages from integer headers.
 * - Reserves remaining <20% hour or <10% day quota strictly for HIGH_FULFILLMENT operations
 *   (Order Creation, Official Label Download, Cancellation).
 */
export class QuotaThrottler {
  constructor(private readonly redis: RedisLike) {}

  async recordResponseHeaders(
    courierCode: string,
    accountId: number,
    headers: Record<string, string | undefined>
  ): Promise<void> {
    const prefix = `quota:${courierCode}:${accountId}`;

    const minLeft = this.parseHeader(headers['minute-quota-left']);
    const hourLeft = this.parseHeader(headers['hour-quota-left']);
    const dayLeft = this.parseHeader(headers['day-quota-left']);

    if (minLeft !== null) {
      await this.redis.set(`${prefix}:minute_left`, String(minLeft), 'EX', 60);
    }

    if (hourLeft !== null) {
      await this.redis.set(`${prefix}:hour_left`, String(hourLeft), 'EX', 3600);
      const prevMax = Number((await this.redis.get(`${prefix}:hour_max`)) || 0);
      if (hourLeft > prevMax) {
        await this.redis.set(`${prefix}:hour_max`, String(hourLeft), 'EX', 86400);
      }
    }

    if (dayLeft !== null) {
      await this.redis.set(`${prefix}:day_left`, String(dayLeft), 'EX', 86400);
      const prevDayMax = Number((await this.redis.get(`${prefix}:day_max`)) || 0);
      if (dayLeft > prevDayMax) {
        await this.redis.set(`${prefix}:day_max`, String(dayLeft), 'EX', 86400);
      }
    }
  }

  async canExecute(
    courierCode: string,
    accountId: number,
    priority: OperationPriority
  ): Promise<boolean> {
    if (priority === 'HIGH_FULFILLMENT') {
      return true;
    }

    const prefix = `quota:${courierCode}:${accountId}`;
    const [hourLeftStr, hourMaxStr, dayLeftStr, dayMaxStr] = await Promise.all([
      this.redis.get(`${prefix}:hour_left`),
      this.redis.get(`${prefix}:hour_max`),
      this.redis.get(`${prefix}:day_left`),
      this.redis.get(`${prefix}:day_max`),
    ]);

    if (hourLeftStr !== null) {
      const hourLeft = Number(hourLeftStr);
      const hourMax = Number(hourMaxStr || 1000);
      if (hourLeft / hourMax < 0.2 || hourLeft < 50) {
        return false;
      }
    }

    if (dayLeftStr !== null) {
      const dayLeft = Number(dayLeftStr);
      const dayMax = Number(dayMaxStr || 5000);
      if (dayLeft / dayMax < 0.1 || dayLeft < 200) {
        return false;
      }
    }

    return true;
  }

  private parseHeader(val?: string): number | null {
    if (val === undefined) return null;
    const parsed = parseInt(val, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
}
