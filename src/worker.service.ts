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
    const candidates = await this.database.events.find(
      { kind: 'event', $or: [
        { status: 'pending', availableAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ] },
      { projection: { patientId: 1 } },
    ).sort({ createdAt: 1 }).limit(50).toArray();

    for (const candidate of candidates) {
      if (!candidate.patientId) continue;
      const deadLetter = await this.database.events.findOne({ kind: 'event', patientId: candidate.patientId, status: 'dead_letter' });
      if (deadLetter) continue;

      const lockId = `patient:${candidate.patientId}`;
      const lock = await this.database.events.findOneAndUpdate(
        { _id: lockId, $or: [{ expiresAt: { $lte: now } }, { owner: this.owner }] },
        { $set: { kind: 'patient_lock', patientId: candidate.patientId, owner: this.owner, expiresAt: new Date(now.getTime() + this.leaseMs) } },
        { upsert: true, returnDocument: 'after' },
      ).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return null;
        throw error;
      });
      if (!lock) continue;

      let claimedId: string | undefined;
      let attempts = 0;
      try {
        const event = await this.database.events.findOneAndUpdate(
          { kind: 'event', patientId: candidate.patientId, $or: [
            { status: 'pending', availableAt: { $lte: new Date() } },
            { status: 'processing', leaseUntil: { $lte: new Date() } },
          ] },
          { $set: { status: 'processing', leaseUntil: new Date(Date.now() + this.leaseMs) }, $inc: { attempts: 1 } },
          { sort: { ts: 1, fingerprint: 1 }, returnDocument: 'after' },
        );
        if (!event) continue;
        claimedId = String(event._id);
        attempts = Number(event.attempts ?? 1);

        await new Promise((resolve) => setTimeout(resolve, Number(process.env.PROCESSING_DELAY_MS ?? 5000)));
        await this.database.events.updateOne(
          { _id: event._id, status: 'processing' },
          { $set: { status: 'processed' }, $unset: { leaseUntil: '' } },
        );
      } catch (error) {
        this.logger.error(`Failed patient ${candidate.patientId}`, error instanceof Error ? error.stack : String(error));
        if (claimedId) {
          const exhausted = attempts >= 5;
          await this.database.events.updateOne(
            { _id: claimedId, status: 'processing' },
            { $set: exhausted ? { status: 'dead_letter' } : { status: 'pending', availableAt: new Date(Date.now() + 1000 * 2 ** (attempts - 1)) }, $unset: { leaseUntil: '' } },
          );
        }
      } finally {
        await this.database.events.deleteOne({ _id: lockId, owner: this.owner });
      }
      return true;
    }
    return false;
  }
}
