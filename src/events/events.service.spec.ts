import { EventsService } from './events.service';
import { DatabaseService } from '../database/database.service';

const event = { patientId: 'p1', type: 'vital', data: { value: 70 }, ts: '2026-10-30T12:00:00Z' };

describe('EventsService', () => {
  let service: EventsService;
  let collection: { findOne: jest.Mock; insertOne: jest.Mock };

  beforeEach(() => {
    collection = { findOne: jest.fn(), insertOne: jest.fn() };
    service = new EventsService({ events: collection } as unknown as DatabaseService);
  });

  it('inserts a new event once', async () => {
    collection.findOne.mockResolvedValue(null);
    collection.insertOne.mockResolvedValue({ acknowledged: true });
    const result = await service.accept(event);
    expect(result.duplicate).toBe(false);
    expect(collection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      patientId: event.patientId, type: event.type, data: event.data, ts: event.ts,
      kind: 'event', status: 'pending', fingerprint: expect.any(String),
    }));
  });

  it('returns the existing event for an identical payload', async () => {
    collection.findOne.mockResolvedValue({ _id: 'existing-id' });
    await expect(service.accept(event)).resolves.toEqual({ eventId: 'existing-id', duplicate: true });
    expect(collection.insertOne).not.toHaveBeenCalled();
  });
});
