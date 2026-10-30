import { MongoServerError } from 'mongodb';
import { EventsService } from './events.service';
import { DatabaseService } from '../database/database.service';

function duplicateKeyError(): MongoServerError {
  const error = Object.create(MongoServerError.prototype) as MongoServerError;
  Object.assign(error, { message: 'duplicate', code: 11000 });
  return error;
}

const event = {
  patientId: 'p1',
  type: 'vital',
  data: { value: 70 },
  ts: '2026-10-30T12:00:00Z',
};

describe('EventsService', () => {
  let service: EventsService;
  let collection: { findOne: jest.Mock; insertOne: jest.Mock };

  beforeEach(() => {
    collection = { findOne: jest.fn(), insertOne: jest.fn() };
    service = new EventsService({ events: collection } as unknown as DatabaseService);
  });

  it('inserts an event and acknowledges it after the write', async () => {
    collection.insertOne.mockResolvedValue({ acknowledged: true });

    const result = await service.accept(event);

    expect(result.duplicate).toBe(false);
    expect(collection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      patientId: event.patientId,
      type: event.type,
      data: event.data,
      ts: event.ts,
      eventTime: new Date(event.ts),
      kind: 'event',
      status: 'pending',
      fingerprint: expect.any(String),
    }));
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  it('returns the stored event when the unique index rejects a duplicate', async () => {
    collection.insertOne.mockRejectedValue(duplicateKeyError());
    collection.findOne.mockResolvedValue({ _id: 'existing-id', kind: 'event' });

    await expect(service.accept(event)).resolves.toEqual({ eventId: 'existing-id', duplicate: true });
  });

  it('rethrows a duplicate-key error when it was not this event fingerprint', async () => {
    const error = duplicateKeyError();
    collection.insertOne.mockRejectedValue(error);
    collection.findOne.mockResolvedValue(null);

    await expect(service.accept(event)).rejects.toBe(error);
  });
});
