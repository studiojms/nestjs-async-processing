import { randomUUID } from 'node:crypto';
import type { PatientEvent } from '../src/common/event';

interface Options {
  count: number;
  rate: number;
  patients: number;
  duplicateRatio: number;
  seed: number;
  disorderMs: number;
  drainTimeoutSeconds: number;
  baseUrl: string;
  maxInFlight: number;
}

const DUPLICATE_POOL_SIZE = 10_000;
const LATENCY_SAMPLE_SIZE = 20_000;
const STATS_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface EventStats {
  pending: number;
  processing: number;
  processed: number;
  dead_letter: number;
  needs_reconciliation: number;
}

export function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const allowed = new Set([
    'count', 'rate', 'patients', 'duplicate-ratio', 'seed', 'disorder-ms',
    'drain-timeout-seconds', 'base-url', 'max-in-flight',
  ]);

  for (const argument of argv) {
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [key, ...parts] = argument.slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    if (values.has(key)) throw new Error(`Option repeated: --${key}`);
    values.set(key, parts.join('='));
  }

  const number = (key: string, fallback: number): number => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`Invalid --${key}`);
    return value;
  };

  const options: Options = {
    count: number('count', 1000),
    rate: number('rate', 17),
    patients: number('patients', 500),
    duplicateRatio: number('duplicate-ratio', 0),
    seed: number('seed', 42),
    disorderMs: number('disorder-ms', 0),
    drainTimeoutSeconds: number('drain-timeout-seconds', 900),
    baseUrl: values.get('base-url') ?? 'http://localhost:3000',
    maxInFlight: number('max-in-flight', 500),
  };

  for (const key of ['count', 'patients', 'seed', 'maxInFlight'] as const) {
    if (!Number.isInteger(options[key])) throw new Error(`--${key} must be an integer`);
  }
  if (options.count < 1) throw new Error('--count must be >= 1');
  if (options.rate <= 0) throw new Error('--rate must be > 0');
  if (options.patients < 1) throw new Error('--patients must be >= 1');
  if (options.duplicateRatio < 0 || options.duplicateRatio > 1) {
    throw new Error('--duplicate-ratio must be between 0 and 1');
  }
  if (options.disorderMs < 0) throw new Error('--disorder-ms must be >= 0');
  if (options.drainTimeoutSeconds < 1) throw new Error('--drain-timeout-seconds must be >= 1');
  if (options.maxInFlight < 1) throw new Error('--max-in-flight must be >= 1');

  const url = new URL(options.baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--base-url must use http or https');
  }
  options.baseUrl = url.toString().replace(/\/$/, '');
  return options;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createEvent(
  index: number,
  patients: number,
  eventTime: number,
  disorderMs: number,
  random: () => number,
): PatientEvent {
  const patientNumber = Math.floor(random() * patients);
  const types = ['observation', 'medication', 'vital-sign', 'encounter'];
  const type = types[Math.floor(random() * types.length)];
  const disorder = disorderMs === 0
    ? 0
    : Math.floor((random() * 2 - 1) * disorderMs);

  return {
    patientId: `patient-${String(patientNumber).padStart(6, '0')}`,
    type,
    data: {
      sequence: index,
      value: Math.round(random() * 2000) / 10,
      unit: type === 'observation' || type === 'vital-sign' ? 'unit' : 'n/a',
      confidence: Math.round(random() * 100) / 100,
    },
    ts: new Date(Math.max(0, eventTime + disorder)).toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function hasDrained(stats: EventStats): boolean {
  return stats.pending === 0 && stats.processing === 0;
}

async function getStats(baseUrl: string): Promise<EventStats | null> {
  try {
    const response = await fetch(`${baseUrl}/stats`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json() as Partial<EventStats>;
    if (typeof body.pending !== 'number' || typeof body.processing !== 'number') return null;
    return {
      pending: body.pending,
      processing: body.processing,
      processed: body.processed ?? 0,
      dead_letter: body.dead_letter ?? 0,
      needs_reconciliation: body.needs_reconciliation ?? 0,
    };
  } catch {
    return null;
  }
}

async function checkApi(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`API health check failed: HTTP ${response.status}`);
}

function usage(): void {
  console.log(`Usage: npm run load:events -- [options]

Options use --name=value syntax:
  --count=100000              Number of POST requests (default: 1000)
  --rate=1000                 Target requests per second (default: 17)
  --patients=5000             Number of patient IDs (default: 500)
  --duplicate-ratio=0.05      Fraction of requests reusing an earlier event
  --disorder-ms=0             Random timestamp disorder in either direction
  --max-in-flight=500         Maximum concurrent HTTP requests
  --base-url=http://localhost:3000
  --drain-timeout-seconds=900
  --seed=42`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) return usage();

  const options = parseOptions(process.argv.slice(2));
  await checkApi(options.baseUrl);

  const random = seededRandom(options.seed);
  const latencyRandom = seededRandom(options.seed + 1);
  const intervalMs = 1000 / options.rate;
  const startedAt = Date.now();
  const duplicatePool: PatientEvent[] = [];
  const latencies: number[] = [];
  const inFlight = new Set<Promise<void>>();
  const statuses: Record<string, number> = {};
  let duplicatePoolIndex = 0;
  let uniqueRequestsGenerated = 0;
  let duplicateRequestsGenerated = 0;
  let duplicateResponses = 0;
  let errors = 0;
  let maxInFlight = 0;
  let latencyCount = 0;
  let statsSamples = 0;
  let statsErrors = 0;
  let maxPending = 0;
  let maxProcessing = 0;
  let latestStats: EventStats | null = null;
  let sampling = true;
  let lastOfferedAt = startedAt;

  const recordLatency = (value: number) => {
    latencyCount += 1;
    if (latencies.length < LATENCY_SAMPLE_SIZE) {
      latencies.push(value);
      return;
    }
    const index = Math.floor(latencyRandom() * latencyCount);
    if (index < latencies.length) latencies[index] = value;
  };

  const sampleStats = async () => {
    const stats = await getStats(options.baseUrl);
    if (!stats) {
      statsErrors += 1;
      return;
    }
    latestStats = stats;
    statsSamples += 1;
    maxPending = Math.max(maxPending, stats.pending);
    maxProcessing = Math.max(maxProcessing, stats.processing);
  };

  const sampler = (async () => {
    while (sampling) {
      await sleep(STATS_INTERVAL_MS);
      if (sampling) await sampleStats();
    }
  })();

  const send = (event: PatientEvent): void => {
    const task = (async () => {
      const requestStarted = Date.now();
      try {
        const response = await fetch(`${options.baseUrl}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        recordLatency(Date.now() - requestStarted);
        statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
        if (!response.ok) {
          errors += 1;
          if (errors <= 5) console.error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
          return;
        }
        const body = await response.json() as { duplicate?: boolean };
        if (body.duplicate) duplicateResponses += 1;
      } catch (error) {
        errors += 1;
        if (errors <= 5) console.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => inFlight.delete(task));
    inFlight.add(task);
    maxInFlight = Math.max(maxInFlight, inFlight.size);
  };

  console.log(`Sending ${options.count} requests at ${options.rate}/s to ${options.baseUrl}`);
  console.log(`Patients=${options.patients}, duplicates=${options.duplicateRatio}, disorder=${options.disorderMs}ms, maxInFlight=${options.maxInFlight}, seed=${options.seed}`);

  for (let index = 0; index < options.count; index += 1) {
    const scheduledAt = startedAt + index * intervalMs;
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    while (inFlight.size >= options.maxInFlight) await Promise.race(inFlight);

    let event: PatientEvent;
    if (duplicatePool.length > 0 && random() < options.duplicateRatio) {
      event = duplicatePool[Math.floor(random() * duplicatePool.length)];
      duplicateRequestsGenerated += 1;
    } else {
      event = createEvent(index, options.patients, scheduledAt, options.disorderMs, random);
      uniqueRequestsGenerated += 1;
      if (options.duplicateRatio > 0) {
        if (duplicatePool.length < DUPLICATE_POOL_SIZE) duplicatePool.push(event);
        else {
          duplicatePool[duplicatePoolIndex] = event;
          duplicatePoolIndex = (duplicatePoolIndex + 1) % DUPLICATE_POOL_SIZE;
        }
      }
    }

    lastOfferedAt = Date.now();
    send(event);
  }

  await Promise.all(inFlight);
  const offeredSeconds = Math.max((lastOfferedAt - startedAt + intervalMs) / 1000, 0.001);
  sampling = false;
  await sampler;

  console.log('Traffic generation finished. Waiting for queue drain...');
  const drainStarted = Date.now();
  let drained = false;
  while (Date.now() - drainStarted < options.drainTimeoutSeconds * 1000) {
    await sampleStats();
    if (latestStats && hasDrained(latestStats)) {
      drained = true;
      break;
    }
    await sleep(STATS_INTERVAL_MS);
  }

  const summary = {
    runId: randomUUID(),
    configuration: options,
    offeredRequests: options.count,
    uniqueRequestsGenerated,
    duplicateRequestsGenerated,
    duplicateResponsesObserved: duplicateResponses,
    httpStatuses: statuses,
    errors,
    requestRate: {
      targetPerSecond: options.rate,
      achievedPerSecond: Number((options.count / offeredSeconds).toFixed(2)),
      offeredDurationSeconds: Number(offeredSeconds.toFixed(2)),
    },
    latencyMs: {
      samples: latencyCount,
      sampleLimit: LATENCY_SAMPLE_SIZE,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    client: { maxInFlight, duplicatePoolSize: duplicatePool.length },
    queue: {
      statsSamples,
      statsErrors,
      maxPending,
      maxProcessing,
      drainSeconds: Number(((Date.now() - drainStarted) / 1000).toFixed(2)),
      drained,
      final: latestStats,
    },
  };

  console.log('\n=== Load test summary ===');
  console.log(JSON.stringify(summary, null, 2));
  if (errors > 0 || !drained) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
