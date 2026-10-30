import { createEvent, parseOptions, seededRandom } from './load-events';

describe('load test options', () => {
  it('uses sensible defaults', () => {
    expect(parseOptions([])).toMatchObject({
      count: 1000,
      rate: 17,
      patients: 500,
      duplicateRatio: 0,
      maxInFlight: 500,
      baseUrl: 'http://localhost:3000',
    });
  });

  it('parses load controls', () => {
    expect(parseOptions([
      '--count=20000',
      '--rate=250',
      '--patients=1000',
      '--duplicate-ratio=0.2',
      '--max-in-flight=80',
      '--base-url=http://127.0.0.1:3100/',
    ])).toMatchObject({
      count: 20000,
      rate: 250,
      patients: 1000,
      duplicateRatio: 0.2,
      maxInFlight: 80,
      baseUrl: 'http://127.0.0.1:3100',
    });
  });

  it.each([
    ['--count=0'],
    ['--rate=0'],
    ['--patients=0'],
    ['--duplicate-ratio=1.1'],
    ['--max-in-flight=0'],
    ['--base-url=ftp://localhost'],
    ['--not-an-option=1'],
  ])('rejects invalid arguments: %s', (argument) => {
    expect(() => parseOptions([argument])).toThrow();
  });
});

describe('load event generation', () => {
  it('is deterministic for a fixed seed', () => {
    const first = createEvent(4, 10, 1_800_000_000_000, 0, seededRandom(42));
    const second = createEvent(4, 10, 1_800_000_000_000, 0, seededRandom(42));
    expect(first).toEqual(second);
  });

  it('generates the API event contract', () => {
    const event = createEvent(9, 3, 1_800_000_000_000, 0, seededRandom(10));
    expect(Object.keys(event).sort()).toEqual(['data', 'patientId', 'ts', 'type']);
    expect(event.patientId).toMatch(/^patient-\d{6}$/);
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    expect(event.data).toHaveProperty('sequence', 9);
  });
});
