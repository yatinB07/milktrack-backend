import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

import { TenantTransactionRunner } from '../../common/application/transaction-context.js';
import { SchedulingVendorService } from '../../vendors/application/scheduling-vendor.service.js';
import type { ScheduleGenerationRunClaim } from '../domain/schedule-generation-run.js';
import { ScheduleGenerationRunStore } from './schedule-generation-run.store.js';
import { ScheduleRunProcessor } from './schedule-run-processor.js';
import {
  SCHEDULE_WORKER_OPTIONS,
  ScheduleWorker,
  type ScheduleWorkerOptions,
} from './schedule-worker.js';

type ActiveWork = Map<Promise<void>, AbortController>;

@Injectable()
export class DefaultScheduleWorker extends ScheduleWorker {
  private readonly logger = new Logger(DefaultScheduleWorker.name);

  constructor(
    @Inject(SCHEDULE_WORKER_OPTIONS)
    private readonly options: ScheduleWorkerOptions,
    @Inject(SchedulingVendorService)
    private readonly vendors: SchedulingVendorService,
    @Inject(TenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    @Inject(ScheduleGenerationRunStore)
    private readonly runs: ScheduleGenerationRunStore,
    @Inject(ScheduleRunProcessor)
    private readonly processor: ScheduleRunProcessor,
  ) {
    super();
  }

  async run(signal: AbortSignal): Promise<void> {
    const active: ActiveWork = new Map();
    while (!signal.aborted) {
      try {
        await this.tick(signal, active);
      } catch {
        this.logger.error('SCHEDULE_WORKER_TICK_FAILED');
      }
      if (!signal.aborted) await this.pause(signal);
    }
    await this.drain(active);
  }

  private async tick(signal: AbortSignal, active: ActiveWork): Promise<void> {
    const vendorIds = await this.seedEligibleVendors(signal);
    let claimedInPass: boolean;
    do {
      claimedInPass = false;
      for (const vendorId of vendorIds) {
        if (active.size >= this.options.concurrency) {
          await this.waitForWorkOrAbort(active, signal);
        }
        if (signal.aborted) return;
        let claim: ScheduleGenerationRunClaim | null;
        try {
          claim = await this.transactions.run(vendorId, (transaction) => this.runs.claimNext(
            transaction,
            { vendorId, leaseToken: randomUUID(), now: new Date() },
          ));
        } catch {
          this.logger.error('SCHEDULE_WORKER_CLAIM_FAILED');
          continue;
        }
        if (!claim) continue;
        claimedInPass = true;
        this.start(claim, active);
      }
    } while (claimedInPass && !signal.aborted);

    while (active.size > 0 && !signal.aborted) {
      await this.waitForWorkOrAbort(active, signal);
    }
  }

  private async seedEligibleVendors(signal: AbortSignal): Promise<string[]> {
    const candidates: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.vendors.listEligible({ ...(cursor ? { cursor } : {}), limit: 100 });
      candidates.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor && !signal.aborted);

    const eligible: string[] = [];
    for (const vendorId of candidates) {
      if (signal.aborted) break;
      try {
        const seeded = await this.transactions.run(vendorId, async (transaction) => {
          const vendor = await this.vendors.findEligible(transaction, vendorId);
          if (!vendor) return false;
          const now = new Date();
          const today = DateTime.fromJSDate(now, { zone: vendor.timezone }).toISODate();
          if (!today) return false;
          const serviceDates = Array.from(
            { length: 7 },
            (_, days) => DateTime.fromISO(today).plus({ days }).toISODate()!,
          );
          await this.runs.seedAutomatic(transaction, {
            vendorId,
            triggerLocalDate: today,
            serviceDates,
            now,
          });
          return true;
        });
        if (seeded) eligible.push(vendorId);
      } catch {
        this.logger.error('SCHEDULE_WORKER_VENDOR_SEED_FAILED');
      }
    }
    return eligible;
  }

  private start(claim: ScheduleGenerationRunClaim, active: ActiveWork): void {
    const heartbeat = new AbortController();
    const work = this.process(claim, heartbeat);
    active.set(work, heartbeat);
    void work.then(() => active.delete(work));
  }

  private async process(
    claim: ScheduleGenerationRunClaim,
    heartbeat: AbortController,
  ): Promise<void> {
    const renewal = this.renewWhileOwned(claim, heartbeat.signal);
    try {
      await this.processor.process(claim);
    } catch {
      // The processor durably records retryable or terminal failure before rejecting.
    } finally {
      heartbeat.abort();
      await renewal;
    }
  }

  private async renewWhileOwned(
    claim: ScheduleGenerationRunClaim,
    signal: AbortSignal,
  ): Promise<void> {
    while (await this.wait(this.options.heartbeatIntervalMs, signal)) {
      try {
        const renewed = await this.transactions.run(claim.vendorId, (transaction) => this.runs.renew(
          transaction,
          {
            fence: { id: claim.id, leaseToken: claim.leaseToken, attempt: claim.attempt },
            now: new Date(),
          },
        ));
        if (!renewed) return;
      } catch {
        this.logger.error('SCHEDULE_WORKER_RENEW_FAILED');
        return;
      }
    }
  }

  private async pause(signal: AbortSignal): Promise<void> {
    await this.wait(this.options.pollIntervalMs, signal);
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    try {
      await delay(milliseconds, undefined, { signal });
      return true;
    } catch {
      return false;
    }
  }

  private async waitForWorkOrAbort(active: ActiveWork, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let stop!: () => void;
    const aborted = new Promise<void>((resolve) => {
      stop = resolve;
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      await Promise.race([Promise.race(active.keys()), aborted]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  private async drain(active: ActiveWork): Promise<void> {
    if (active.size === 0) return;
    const timeout = new AbortController();
    let timedOut = false;
    try {
      await Promise.race([
        Promise.all(active.keys()),
        delay(this.options.shutdownTimeoutMs, undefined, { signal: timeout.signal }).then(() => {
          timedOut = true;
        }),
      ]);
    } finally {
      timeout.abort();
    }
    if (timedOut) {
      for (const heartbeat of active.values()) heartbeat.abort();
    }
  }
}
