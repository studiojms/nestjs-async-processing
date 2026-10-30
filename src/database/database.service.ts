import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Collection, MongoClient } from 'mongodb';
import { EventsCollectionRecord } from '../common/event';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private client!: MongoClient;
  private collection?: Collection<EventsCollectionRecord>;

  async onModuleInit(): Promise<void> {
    this.client = new MongoClient(
      process.env.MONGODB_URI ?? 'mongodb://localhost:27017/patient_events',
      {
        maxPoolSize: Number(process.env.MONGO_POOL_SIZE ?? 50),
        retryWrites: true,
        writeConcern: { w: 'majority', j: true },
      },
    );

    await this.client.connect();
    this.collection = this.client.db().collection<EventsCollectionRecord>('events');
    await this.createIndexes();
  }

  get events(): Collection<EventsCollectionRecord> {
    if (!this.collection) throw new Error('MongoDB is not connected');
    return this.collection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  private async createIndexes(): Promise<void> {
    await this.events.createIndexes([
      {
        key: { kind: 1, fingerprint: 1 },
        name: 'uq_event_fingerprint',
        unique: true,
        partialFilterExpression: { kind: 'event' },
      },
      {
        key: { kind: 1, patientId: 1 },
        name: 'uq_patient_lock',
        unique: true,
        partialFilterExpression: { kind: 'patient_lock' },
      },
      {
        key: { kind: 1, status: 1, availableAt: 1, createdAt: 1 },
        name: 'ix_pending_events',
        partialFilterExpression: { kind: 'event', status: 'pending' },
      },
      {
        key: { kind: 1, status: 1, leaseUntil: 1, createdAt: 1 },
        name: 'ix_expired_events',
        partialFilterExpression: { kind: 'event', status: 'processing' },
      },
      {
        key: { kind: 1, patientId: 1, eventTime: 1, fingerprint: 1 },
        name: 'ix_patient_event_order',
        partialFilterExpression: { kind: 'event' },
      },
      {
        key: { kind: 1, patientId: 1, eventTime: -1, fingerprint: -1 },
        name: 'ix_patient_processed_order',
        partialFilterExpression: { kind: 'event', status: 'processed' },
      },
      {
        key: { kind: 1, expiresAt: 1 },
        name: 'ttl_patient_locks',
        expireAfterSeconds: 0,
        partialFilterExpression: { kind: 'patient_lock', blocked: false },
      },
    ]);
  }
}
