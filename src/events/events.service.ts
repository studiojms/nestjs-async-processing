import { Injectable } from '@nestjs/common';
import { MongoServerError } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { CreateEventDto } from './create-event.dto';
import { DatabaseService } from '../database/database.service';
import { fingerprint } from '../common/fingerprint';

@Injectable()
export class EventsService {
  constructor(private readonly database: DatabaseService) {}

  async accept(event: CreateEventDto) {
    const hash = fingerprint(event);
    const existing = await this.database.events.findOne({ kind: 'event', fingerprint: hash });
    if (existing) return { eventId: existing._id, duplicate: true };

    const document = {
      ...event, _id: randomUUID(), kind: 'event' as const, fingerprint: hash,
      status: 'pending' as const, attempts: 0, availableAt: new Date(), createdAt: new Date(),
    };
    try {
      await this.database.events.insertOne(document);
      return { eventId: document._id, duplicate: false };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const duplicate = await this.database.events.findOne({ kind: 'event', fingerprint: hash });
      if (!duplicate) throw error;
      return { eventId: duplicate._id, duplicate: true };
    }
  }
}
