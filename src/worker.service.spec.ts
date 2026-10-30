import { Logger } from '@nestjs/common';
import { WorkerService } from './worker.service';
import { DatabaseService } from './database/database.service';
import { ClaimedEvent, EventDocument } from './common/event';

describe('WorkerService', () => {
  it('does not access MongoDB while Nest is constructing providers', () => {
    const database = Object.defineProperty({}, 'events', {
      get: () => {
        throw new Error('MongoDB is not connected');
      },
    }) as DatabaseService;

    expect(() => new WorkerService(database)).not.toThrow();
  });

  it('returns no claim when the queue has no eligible patients', async () => {
    const collection = {
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    const service = new WorkerService({ events: collection } as unknown as DatabaseService);
    const claimNext = (service as unknown as { claimNext: () => Promise<unknown> }).claimNext;

    await expect(claimNext.call(service)).resolves.toBeNull();
    expect(collection.aggregate).toHaveBeenCalledTimes(1);
  });

  it('claims the earliest event with string IDs and driver 6 return semantics', async () => {
    const head: EventDocument = {
      _id: 'event-1',
      kind: 'event',
      patientId: 'patient-1',
      type: 'observation',
      data: { value: 72 },
      ts: '2026-10-30T12:00:00.000Z',
      eventTime: new Date(Date.now() - 1_000),
      fingerprint: 'fingerprint-1',
      status: 'pending',
      attempts: 0,
      availableAt: new Date(Date.now() - 1_000),
      createdAt: new Date(Date.now() - 2_000),
    };
    const collection = {
      aggregate: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([{ _id: head.patientId }]),
      }),
      findOneAndUpdate: jest.fn()
        .mockImplementationOnce(async (_filter, update) => ({
          _id: 'patient:patient-1',
          kind: 'patient_lock',
          lockToken: update.$set.lockToken,
        }))
        .mockImplementationOnce(async (_filter, update) => ({
          ...head,
          status: 'processing',
          attempts: 1,
          claimToken: update.$set.claimToken,
        })),
      findOne: jest.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(null),
      updateOne: jest.fn(),
      deleteOne: jest.fn(),
    };
    const service = new WorkerService({ events: collection } as unknown as DatabaseService);
    const claimNext = (service as unknown as { claimNext: () => Promise<ClaimedEvent | null> }).claimNext;

    const claim = await claimNext.call(service);

    expect(claim?.event._id).toBe('event-1');
    expect(claim?.event.claimToken).toEqual(expect.any(String));
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(collection.findOneAndUpdate.mock.calls[0][2]).toMatchObject({ includeResultMetadata: false });
    expect(collection.findOneAndUpdate.mock.calls[1][2]).toMatchObject({ includeResultMetadata: false });
    expect(collection.findOneAndUpdate.mock.calls[1][0]).toMatchObject({ _id: 'event-1', kind: 'event' });
    expect(collection.deleteOne).not.toHaveBeenCalled();
  });

  it('completes only the event claim identified by its token', async () => {
    const collection = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    const service = new WorkerService({ events: collection } as unknown as DatabaseService);
    const logger = (service as unknown as { logger: Logger }).logger;
    const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    const claim: ClaimedEvent = {
      event: {
        _id: 'event-1',
        kind: 'event',
        patientId: 'patient-1',
        type: 'observation',
        data: {},
        ts: '2026-10-30T12:00:00.000Z',
        eventTime: new Date(),
        fingerprint: 'fingerprint-1',
        status: 'processing',
        attempts: 1,
        availableAt: new Date(),
        createdAt: new Date(),
        claimToken: 'claim-1',
      },
      patientLockId: 'patient:patient-1',
      lockToken: 'lock-1',
      claimToken: 'claim-1',
    };
    const internals = service as unknown as {
      process: (value: ClaimedEvent) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
    };
    internals.sleep = jest.fn().mockResolvedValue(undefined);

    await internals.process.call(service, claim);

    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'event-1', claimToken: 'claim-1', status: 'processing' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'processed' }) }),
    );
    expect(collection.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'patient:patient-1', lockToken: 'lock-1' }),
    );
    expect(log).toHaveBeenCalledWith(
      'Processed event event-1 (type="observation", attempt=1)',
    );
  });

  it('schedules a retry without storing arbitrary downstream error text', async () => {
    const collection = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    const service = new WorkerService({ events: collection } as unknown as DatabaseService);
    const claim: ClaimedEvent = {
      event: {
        _id: 'event-2',
        kind: 'event',
        patientId: 'patient-2',
        type: 'observation',
        data: {},
        ts: '2026-10-30T12:00:00.000Z',
        eventTime: new Date(),
        fingerprint: 'fingerprint-2',
        status: 'processing',
        attempts: 1,
        availableAt: new Date(),
        createdAt: new Date(),
        claimToken: 'claim-2',
      },
      patientLockId: 'patient:patient-2',
      lockToken: 'lock-2',
      claimToken: 'claim-2',
    };
    const internals = service as unknown as {
      process: (value: ClaimedEvent) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
    };
    internals.sleep = jest.fn().mockRejectedValue(new Error('untrusted patient data'));

    await internals.process.call(service, claim);

    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'event-2', claimToken: 'claim-2' }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'pending', availableAt: expect.any(Date) }),
        $unset: expect.objectContaining({ claimToken: '' }),
      }),
    );
    expect(collection.updateOne.mock.calls[0][1].$set).not.toHaveProperty('lastError');
    expect(collection.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('moves an event to dead_letter after the configured attempt limit', async () => {
    const collection = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    const service = new WorkerService({ events: collection } as unknown as DatabaseService);
    const claim: ClaimedEvent = {
      event: {
        _id: 'event-4',
        kind: 'event',
        patientId: 'patient-4',
        type: 'observation',
        data: {},
        ts: '2026-10-30T12:00:00.000Z',
        eventTime: new Date(),
        fingerprint: 'fingerprint-4',
        status: 'processing',
        attempts: 5,
        availableAt: new Date(),
        createdAt: new Date(),
        claimToken: 'claim-4',
      },
      patientLockId: 'patient:patient-4',
      lockToken: 'lock-4',
      claimToken: 'claim-4',
    };
    const internals = service as unknown as {
      process: (value: ClaimedEvent) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
    };
    internals.sleep = jest.fn().mockRejectedValue(new Error('processing failed'));

    await internals.process.call(service, claim);

    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'event-4', claimToken: 'claim-4' }),
      expect.objectContaining({
        $set: { status: 'dead_letter' },
        $unset: expect.objectContaining({ claimToken: '' }),
      }),
    );
  });

  it('renews the patient and event leases with their fencing tokens', async () => {
    const collection = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new WorkerService({ events: collection } as unknown as DatabaseService);
    const claim: ClaimedEvent = {
      event: {
        _id: 'event-3',
        kind: 'event',
        patientId: 'patient-3',
        type: 'observation',
        data: {},
        ts: '2026-10-30T12:00:00.000Z',
        eventTime: new Date(),
        fingerprint: 'fingerprint-3',
        status: 'processing',
        attempts: 1,
        availableAt: new Date(),
        createdAt: new Date(),
      },
      patientLockId: 'patient:patient-3',
      lockToken: 'lock-3',
      claimToken: 'claim-3',
    };
    const renew = (service as unknown as { renew: (value: ClaimedEvent) => Promise<boolean> }).renew;

    await expect(renew.call(service, claim)).resolves.toBe(true);
    expect(collection.updateOne.mock.calls[0][0]).toMatchObject({ _id: 'patient:patient-3', lockToken: 'lock-3' });
    expect(collection.updateOne.mock.calls[1][0]).toMatchObject({ _id: 'event-3', claimToken: 'claim-3' });
  });
});
