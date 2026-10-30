import { Injectable } from '@nestjs/common';
import { MongoServerError } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../common/fingerprint';
import { CreateEventDto } from './create-event.dto';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class EventsService {
  constructor(private readonly database: DatabaseService) {}

  async accept(event: CreateEventDto) {
    const hash = fingerprint(event);
    const now = new Date();
    const document = {
      ...event,
      _id: randomUUID(),
      kind: 'event' as const,
      fingerprint: hash,
      eventTime: new Date(event.ts),
      status: 'pending' as const,
      attempts: 0,
      availableAt: now,
      createdAt: now,
    };

    try {
      await this.database.events.insertOne(document);
      return { eventId: document._id, duplicate: false };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;

      const duplicate = await this.database.events.findOne({ kind: 'event', fingerprint: hash });
      if (duplicate?.kind !== 'event') throw error;
      return { eventId: duplicate._id, duplicate: true };
    }
  }
}
