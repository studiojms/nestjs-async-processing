import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Collection, MongoClient } from 'mongodb';
import { EventDocument } from '../common/event';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private client!: MongoClient;
  events!: Collection<EventDocument | Record<string, unknown>>;

  async onModuleInit(): Promise<void> {
    this.client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/patient_events', {
      maxPoolSize: Number(process.env.MONGO_POOL_SIZE ?? 50),
    });
    await this.client.connect();
    const db = this.client.db();
    this.events = db.collection('events');
    await this.events.createIndex({ kind: 1, fingerprint: 1 }, { unique: true, partialFilterExpression: { kind: 'event' } });
    await this.events.createIndex({ kind: 1, status: 1, availableAt: 1, createdAt: 1 });
    await this.events.createIndex({ kind: 1, patientId: 1, status: 1, ts: 1, fingerprint: 1 });
    await this.events.createIndex({ kind: 1, expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { kind: 'patient_lock' } });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }
}
