import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Document, Filter, MongoServerError } from 'mongodb';
import { randomUUID } from 'node:crypto';
import {
  ClaimedEvent,
  EventDocument,
  EventsCollectionRecord,
  PatientLockDocument,
} from './common/event';
import { compareEventOrder } from './common/event-ordering';
import { DatabaseService } from './database/database.service';

interface PatientCandidate extends Document {
  _id: string;
}

@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly owner = randomUUID();
  private readonly concurrency = Number(process.env.WORKER_CONCURRENCY ?? 10);
  private readonly pollMs = Number(process.env.WORKER_POLL_MS ?? 100);
  private readonly leaseMs = Number(process.env.LOCK_LEASE_MS ?? 30_000);
  private readonly maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 5);
  private readonly active = new Set<Promise<void>>();
  private stopping = false;
  private loop?: Promise<void>;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    this.logger.log(`Worker started (concurrency=${this.concurrency})`);
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private get events() {
    return this.database.events;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let claimed = false;

      while (!this.stopping && this.active.size < this.concurrency) {
        try {
          const claim = await this.claimNext();
          if (!claim) break;

          claimed = true;
          let task: Promise<void>;
          task = this.process(claim)
            .catch((error: unknown) => {
              this.logger.error(`Worker task failed: ${this.errorName(error)}`);
            })
            .finally(() => this.active.delete(task));
          this.active.add(task);
        } catch (error) {
          this.logger.error(`Could not claim an event: ${this.errorName(error)}`);
          break;
        }
      }

      if (!claimed || this.active.size >= this.concurrency) await this.sleep(this.pollMs);
    }

    await Promise.allSettled(this.active);
    this.logger.log('Worker stopped');
  }

  private async claimNext(): Promise<ClaimedEvent | null> {
    const now = new Date();
    const candidates = await this.events.aggregate<PatientCandidate>([
      {
        $match: {
          kind: 'event',
          $or: [
            { status: 'pending', availableAt: { $lte: now } },
            { status: 'processing', leaseUntil: { $lte: now } },
          ],
        },
      },
      { $group: { _id: '$patientId', firstSeen: { $min: '$createdAt' } } },
      {
        $lookup: {
          from: 'events',
          localField: '_id',
          foreignField: 'patientId',
          pipeline: [
            {
              $match: {
                kind: 'event',
                status: { $in: ['pending', 'processing', 'dead_letter', 'needs_reconciliation'] },
              },
            },
            { $sort: { eventTime: 1, fingerprint: 1 } },
            { $limit: 1 },
          ],
          as: 'head',
        },
      },
      {
        $match: {
          $or: [
            { 'head.status': 'pending', 'head.availableAt': { $lte: now } },
            { 'head.status': 'processing', 'head.leaseUntil': { $lte: now } },
            { 'head.status': { $in: ['dead_letter', 'needs_reconciliation'] } },
          ],
        },
      },
      {
        $lookup: {
          from: 'events',
          localField: '_id',
          foreignField: 'patientId',
          pipeline: [
            {
              $match: {
                kind: 'patient_lock',
                $or: [{ blocked: true }, { expiresAt: { $gt: now } }],
              },
            },
            { $limit: 1 },
          ],
          as: 'unavailable',
        },
      },
      { $match: { unavailable: { $eq: [] } } },
      { $sort: { firstSeen: 1, _id: 1 } },
      { $limit: 100 },
      { $project: { _id: 1 } },
    ], { allowDiskUse: true }).toArray();

    for (const candidate of candidates) {
      const claim = await this.tryClaimPatient(candidate._id, now);
      if (claim) return claim;
    }
    return null;
  }

  private async tryClaimPatient(patientId: string, now: Date): Promise<ClaimedEvent | null> {
    const patientLockId = `patient:${patientId}`;
    const lockToken = randomUUID();
    const expiresAt = new Date(now.getTime() + this.leaseMs);

    try {
      const lock = await this.events.findOneAndUpdate(
        {
          _id: patientLockId,
          kind: 'patient_lock',
          blocked: false,
          $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $lte: now } }],
        },
        {
          $set: { kind: 'patient_lock', patientId, owner: this.owner, lockToken, expiresAt },
          $setOnInsert: { createdAt: now, blocked: false },
        },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false },
      ) as PatientLockDocument | null;
      if (!lock || lock.lockToken !== lockToken) return null;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return null;
      throw error;
    }

    let keepLock = false;
    try {
      const head = await this.events.findOne(
        {
          kind: 'event',
          patientId,
          status: { $in: ['pending', 'processing', 'dead_letter', 'needs_reconciliation'] },
        },
        { sort: { eventTime: 1, fingerprint: 1 } },
      ) as EventDocument | null;
      if (!head) return null;

      if (head.status === 'dead_letter' || head.status === 'needs_reconciliation') {
        await this.blockPatient(patientLockId, lockToken);
        return null;
      }

      if (head.status === 'pending' && head.availableAt > now) return null;
      if (head.status === 'processing' && head.leaseUntil && head.leaseUntil > now) return null;

      const latestProcessed = await this.events.findOne(
        { kind: 'event', patientId, status: 'processed' },
        { sort: { eventTime: -1, fingerprint: -1 } },
      ) as EventDocument | null;
      if (latestProcessed && compareEventOrder(head, latestProcessed) <= 0) {
        await this.events.updateOne(
          { _id: head._id, kind: 'event', status: head.status },
          { $set: { status: 'needs_reconciliation', reconciliationReason: 'older_than_processed_event' } },
        );
        await this.blockPatient(patientLockId, lockToken);
        return null;
      }

      const claimToken = randomUUID();
      const leaseUntil = new Date(Date.now() + this.leaseMs);
      const claimFilter: Filter<EventsCollectionRecord> = {
        _id: head._id,
        kind: 'event',
        status: head.status,
        ...(head.status === 'pending'
          ? { availableAt: { $lte: now } }
          : { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] }),
      };
      const claimed = await this.events.findOneAndUpdate(
        claimFilter,
        {
          $set: { status: 'processing', leaseOwner: this.owner, leaseUntil, claimToken },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      ) as EventDocument | null;
      if (!claimed) return null;

      keepLock = true;
      return {
        event: claimed,
        patientLockId,
        lockToken,
        claimToken,
      };
    } finally {
      if (!keepLock) await this.releaseLock(patientLockId, lockToken);
    }
  }

  private async process(claim: ClaimedEvent): Promise<void> {
    let heartbeat: Promise<void> | undefined;
    let leaseLost = false;
    const heartbeatMs = Math.max(500, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = this.renew(claim)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch((error: unknown) => {
          this.logger.warn(`Lease renewal failed: ${this.errorName(error)}`);
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, heartbeatMs);
    timer.unref?.();

    try {
      // Replace this delay with the actual downstream operation in the exercise.
      await this.sleep(Number(process.env.PROCESSING_DELAY_MS ?? 5000));

      if (leaseLost) return;
      const result = await this.events.updateOne(
        {
          _id: claim.event._id,
          kind: 'event',
          status: 'processing',
          claimToken: claim.claimToken,
        },
        {
          $set: { status: 'processed', processedAt: new Date() },
          $unset: { leaseOwner: '', leaseUntil: '', claimToken: '' },
        },
      );
      if (result.modifiedCount !== 1) this.logger.warn('A stale worker could not complete its claim');
    } catch (error) {
      await this.fail(claim, error);
    } finally {
      clearInterval(timer);
      if (heartbeat) await heartbeat;
      await this.releaseLock(claim.patientLockId, claim.lockToken);
    }
  }

  private async renew(claim: ClaimedEvent): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseMs);
    const lock = await this.events.updateOne(
      {
        _id: claim.patientLockId,
        kind: 'patient_lock',
        owner: this.owner,
        lockToken: claim.lockToken,
        expiresAt: { $gt: now },
      },
      { $set: { expiresAt } },
    );
    if (lock.modifiedCount !== 1) return false;

    const event = await this.events.updateOne(
      {
        _id: claim.event._id,
        kind: 'event',
        status: 'processing',
        claimToken: claim.claimToken,
      },
      { $set: { leaseUntil: expiresAt } },
    );
    return event.modifiedCount === 1;
  }

  private async fail(claim: ClaimedEvent, error: unknown): Promise<void> {
    const exhausted = claim.event.attempts >= this.maxAttempts;
    const availableAt = new Date(Date.now() + 1000 * 2 ** (claim.event.attempts - 1));
    await this.events.updateOne(
      {
        _id: claim.event._id,
        kind: 'event',
        status: 'processing',
        claimToken: claim.claimToken,
      },
      {
        $set: exhausted
          ? { status: 'dead_letter' }
          : { status: 'pending', availableAt },
        $unset: { leaseOwner: '', leaseUntil: '', claimToken: '' },
      },
    );
    this.logger.error(`Event processing failed: ${this.errorName(error)}`);
  }

  private async blockPatient(patientLockId: string, lockToken: string): Promise<void> {
    await this.events.updateOne(
      { _id: patientLockId, kind: 'patient_lock', owner: this.owner, lockToken },
      { $set: { blocked: true }, $unset: { owner: '', lockToken: '', expiresAt: '' } },
    );
  }

  private async releaseLock(patientLockId: string, lockToken: string): Promise<void> {
    await this.events.deleteOne({
      _id: patientLockId,
      kind: 'patient_lock',
      owner: this.owner,
      lockToken,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }
}
