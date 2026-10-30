import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from './database/database.service';

@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private running = true;
  private readonly owner = randomUUID();
  private readonly pollMs = Number(process.env.WORKER_POLL_MS ?? 100);
  private readonly leaseMs = Number(process.env.LOCK_LEASE_MS ?? 30_000);

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void { void this.run(); }
  onModuleDestroy(): void { this.running = false; }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.processOnePatient())) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      } catch (error) {
        this.logger.error('Worker iteration failed', error instanceof Error ? error.stack : String(error));
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    }
  }

  private async processOnePatient(): Promise<boolean> {
    const now = new Date();
    const candidate = await this.database.events.findOne(
      { kind: 'event', $or: [
        { status: 'pending', availableAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ] },
      { sort: { createdAt: 1 }, projection: { patientId: 1 } },
    );
    if (!candidate?.patientId) return false;

    const lockId = `patient:${candidate.patientId}`;
    const lock = await this.database.events.findOneAndUpdate(
      { _id: lockId, $or: [{ expiresAt: { $lte: now } }, { owner: this.owner }] },
      { $set: { kind: 'patient_lock', patientId: candidate.patientId, owner: this.owner, expiresAt: new Date(now.getTime() + this.leaseMs) } },
      { upsert: true, returnDocument: 'after' },
    ).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return null;
      throw error;
    });
    if (!lock) return false;

    let claimedId: string | undefined;
    let attempts = 0;
    try {
      const deadLetter = await this.database.events.findOne({ kind: 'event', patientId: candidate.patientId, status: 'dead_letter' });
      if (deadLetter) return false;

      const event = await this.database.events.findOneAndUpdate(
        { kind: 'event', patientId: candidate.patientId, $or: [
          { status: 'pending', availableAt: { $lte: new Date() } },
          { status: 'processing', leaseUntil: { $lte: new Date() } },
        ] },
        { $set: { status: 'processing', leaseUntil: new Date(Date.now() + this.leaseMs) }, $inc: { attempts: 1 } },
        { sort: { ts: 1, fingerprint: 1 }, returnDocument: 'after' },
      );
      if (!event) return false;
      claimedId = String(event._id);
      attempts = Number(event.attempts ?? 1);

      await new Promise((resolve) => setTimeout(resolve, Number(process.env.PROCESSING_DELAY_MS ?? 5000)));
      await this.database.events.updateOne({ _id: event._id, status: 'processing' }, { $set: { status: 'processed' }, $unset: { leaseUntil: '' } });
      return true;
    } catch (error) {
      this.logger.error(`Failed patient ${candidate.patientId}`, error instanceof Error ? error.stack : String(error));
      if (claimedId) {
        const exhausted = attempts >= 5;
        await this.database.events.updateOne(
          { _id: claimedId, status: 'processing' },
          { $set: exhausted ? { status: 'dead_letter' } : { status: 'pending', availableAt: new Date(Date.now() + 1000 * 2 ** (attempts - 1)) }, $unset: { leaseUntil: '' } },
        );
      }
      return true;
    } finally {
      await this.database.events.deleteOne({ _id: lockId, owner: this.owner });
    }
  }
}
