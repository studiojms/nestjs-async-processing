import { compareEventOrder } from '../src/common/event-ordering';

describe('patient stream ordering', () => {
  it('orders timestamps chronologically and uses the fingerprint as a tie-breaker', () => {
    const events = [
      { eventTime: new Date('2026-01-02T00:00:00Z'), fingerprint: 'b' },
      { eventTime: new Date('2026-01-01T00:00:00Z'), fingerprint: 'z' },
      { eventTime: new Date('2026-01-01T00:00:00Z'), fingerprint: 'a' },
    ];

    expect(events.sort(compareEventOrder).map((event) => event.fingerprint)).toEqual(['a', 'z', 'b']);
  });

  it('compares equivalent timestamps with different timezone offsets correctly', () => {
    const earlier = { eventTime: new Date('2026-01-01T09:00:00-03:00'), fingerprint: 'b' };
    const later = { eventTime: new Date('2026-01-01T12:30:00Z'), fingerprint: 'a' };

    expect(compareEventOrder(earlier, later)).toBeLessThan(0);
  });
});
