describe('patient stream ordering', () => {
  it('uses event timestamp then fingerprint as a stable tie-breaker', () => {
    const events = [
      { ts: '2026-01-02', fingerprint: 'b' },
      { ts: '2026-01-01', fingerprint: 'z' },
      { ts: '2026-01-01', fingerprint: 'a' },
    ];
    expect(events.sort((a, b) => a.ts.localeCompare(b.ts) || a.fingerprint.localeCompare(b.fingerprint)).map((e) => e.fingerprint)).toEqual(['a', 'z', 'b']);
  });
});
