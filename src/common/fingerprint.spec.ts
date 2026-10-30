import { fingerprint } from './fingerprint';
import { PatientEvent } from './event';

const event: PatientEvent = { patientId: 'p1', type: 'vital', data: { z: 1, a: { y: 2, x: 3 } }, ts: '2026-10-30T12:00:00Z' };

describe('fingerprint', () => {
  it('ignores object key order recursively', () => {
    expect(fingerprint(event)).toBe(fingerprint({ ...event, data: { a: { x: 3, y: 2 }, z: 1 } }));
  });
  it('preserves array order and scalar values', () => {
    expect(fingerprint(event)).not.toBe(fingerprint({ ...event, data: { z: 1, a: { y: 2, x: 4 } } }));
  });
});
