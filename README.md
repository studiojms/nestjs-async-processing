# Patient event ingestion

A small NestJS + TypeScript implementation for testing durable event ingestion and asynchronous processing. It deliberately uses MongoDB as both the accepted-event store and the work queue; there is no broker, repository layer, or generic worker framework.

The code is a benchmarkable baseline, not a claim that this exact MongoDB polling design can sustain a billion events per day. The implementation keeps the correctness rules visible so the bottleneck can be measured before the architecture is expanded.

## Problem contract

`POST /events` accepts one event with exactly four fields:

```json
{
  "patientId": "patient-123",
  "type": "observation",
  "data": { "heartRate": 72 },
  "ts": "2026-10-30T12:00:00.000Z"
}
```

- `patientId` identifies the patient stream.
- `type` identifies the event type.
- `data` contains the event payload.
- `ts` is the event time and determines its position in the patient stream.

The API rejects unknown fields and invalid values. It does not accept a sender-generated event ID or an idempotency header.

## How ingestion works

1. The API validates the four-field request.
2. It canonicalizes the JSON payload (object keys are sorted recursively) and calculates a SHA-256 fingerprint.
3. It inserts a `pending` event and returns `202 Accepted` only after MongoDB acknowledges the write.
4. A unique partial index on `(kind, fingerprint)` is the concurrency-safe deduplication boundary. If two API replicas insert the same payload at the same time, one insert wins and the other reads the winner. The normal path performs one database write; the extra read happens only for a duplicate-key response.

**Identity trade-off:** two events with identical `patientId`, `type`, `data`, and `ts` are treated as the same event. Without an event ID from the sender, the server cannot distinguish a retransmission from two genuinely separate but identical events.

## How processing works

The API and worker are separate NestJS processes. Any number of API and worker replicas can connect to the same MongoDB database.

A worker repeatedly:

1. Finds up to 100 distinct patient streams whose earliest unresolved event is ready or has an expired processing lease. The aggregation groups by `patientId`, so a patient with a large backlog does not occupy every candidate slot, and excludes delayed, dead-lettered, or already leased stream heads before applying the limit.
2. Skips patients with an active or blocked lock.
3. Atomically acquires a short-lived lock for one patient using a deterministic lock ID and a random lock token. A competing worker loses the race through MongoDB's unique `_id` constraint; this is an expected coordination outcome.
4. Reads the patient's earliest unresolved event, ordered by `eventTime` and then fingerprint. It does not skip an earlier event just because a later event is ready.
5. Atomically changes that event to `processing`, increments `attempts`, and writes a claim token and lease expiry.
6. Simulates the downstream work using `PROCESSING_DELAY_MS`, then marks the event `processed` only when its claim token still matches.
7. Releases the patient lock. A heartbeat renews both leases while work is running.

Different patients can be processed concurrently, up to `WORKER_CONCURRENCY` per worker process. A single patient's stream remains serial by design. Adding workers increases throughput across patients, not within one hot patient's ordered stream.

### Why both a lock and a claim token?

The patient lock prevents two workers from intentionally processing the same patient at once. The event claim token is a fencing check: if a lease expires and another worker reclaims the event, an older worker cannot overwrite the newer claim when it eventually finishes. Lease renewal reduces unnecessary takeovers during long-running work.

A lease is not exactly-once execution. A worker can perform an external side effect and crash before recording `processed`; the event may then be attempted again. A real downstream operation must therefore be idempotent, normally using the event fingerprint or a stable event ID as its idempotency key.

## Event states and failure behavior

```text
pending ──claim──> processing ──success──> processed
   ▲                    │
   └──── retry delay ───┘
                        └── attempts exhausted ──> dead_letter
```

- `pending`: accepted and waiting to be processed. `availableAt` also schedules retries.
- `processing`: claimed by a worker until `leaseUntil`.
- `processed`: completed successfully; terminal.
- `dead_letter`: retry limit reached. It stays at the head of the patient stream and blocks later events until an operator resolves it.
- `needs_reconciliation`: an event arrived late and sorts before an already processed event. The worker does not silently apply it out of order; the stream is blocked for reconciliation.

A worker crash leaves the event in `processing`. Once its lease expires, another worker can reclaim it. Failures are retried with exponential delays for up to `MAX_ATTEMPTS` attempts.

To unblock a patient, an operator must first resolve the failed or late event and reconcile any downstream state. Only then should the event be marked `processed` or safely returned to `pending`, and its patient lock reset. For example, after the event itself has been deliberately resolved:

```javascript
db.events.updateOne(
  { _id: 'patient:patient-123', kind: 'patient_lock', blocked: true },
  { $set: { blocked: false } },
);
```

Do not reset a `needs_reconciliation` event to `pending` unless the downstream state has been reconciled; that would re-apply an event that is older than already-applied state.

## Ordering guarantee and its boundary

For events already known to the system, a patient is processed in ascending `ts` order. `eventTime` stores the parsed timestamp, so timestamps with different timezone offsets are compared chronologically rather than lexicographically. The fingerprint is a deterministic tie-breaker for equal timestamps; it does not establish the sender's true order when timestamps are equal.

No system can know that an earlier event is still on its way unless the sender provides a watermark or the ingestion contract defines a lateness window. This baseline detects an event that arrives earlier than the latest processed cursor and marks it `needs_reconciliation`. It does not automatically rewind or replay already-applied downstream state.

## MongoDB documents and indexes

The `events` collection contains two document kinds:

- `kind: "event"`: the immutable four-field payload plus operational processing fields.
- `kind: "patient_lock"`: the lease for one patient. A blocked lock has no expiry and remains until manually resolved.

Both kinds use string `_id` values. The collection is typed accordingly; it does not rely on the driver's default `ObjectId` inference. This is also why `findOneAndUpdate` uses `includeResultMetadata: false`: with MongoDB Node driver 6, the application wants the updated document directly, not the legacy metadata wrapper.

Indexes are created at startup:

| Index | Purpose |
|---|---|
| Unique `(kind, fingerprint)` for events | Deduplicate concurrent API requests |
| Unique `(kind, patientId)` for patient locks | One persistent lock record per patient |
| Pending status + `availableAt` | Find ready events |
| Processing status + `leaseUntil` | Recover abandoned claims |
| Patient + `eventTime` + fingerprint | Read the unresolved stream head |
| Patient + descending `eventTime` + fingerprint | Find the processed cursor |
| TTL on unblocked patient lock expiry | Remove abandoned lock documents after their lease |

## Run locally

Requires Node.js 22+, npm, and Docker Compose.

```bash
cp .env.example .env
docker compose up --build --scale worker=3
```

The API listens on `http://localhost:3000`.

```bash
curl -i http://localhost:3000/events \
  -H 'content-type: application/json' \
  -d '{"patientId":"patient-123","type":"observation","data":{"heartRate":72},"ts":"2026-10-30T12:00:00.000Z"}'
```

`GET /health` checks database connectivity. `GET /stats` reports event counts by state, including events requiring reconciliation.

To stop the stack:

```bash
docker compose down
```

Use `docker compose down -v` only when you also want to delete the local MongoDB data volume.

## Development and checks

```bash
npm install
npm test
npm run lint
npm run build
```

The unit tests cover canonical fingerprints, request validation, duplicate ingestion (including concurrent duplicate inserts), worker startup timing, and event ordering. The tests do not require a running MongoDB instance. The application and worker require MongoDB when run.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `MONGODB_URI` | `mongodb://localhost:27017/patient_events` | MongoDB connection string |
| `MONGO_POOL_SIZE` | `50` | Maximum connections in each process pool |
| `PORT` | `3000` | API port |
| `WORKER_CONCURRENCY` | `10` | Maximum in-flight events per worker process |
| `WORKER_POLL_MS` | `100` | Delay when no claim is available |
| `LOCK_LEASE_MS` | `30000` | Patient and event lease duration |
| `MAX_ATTEMPTS` | `5` | Attempts before dead-lettering |
| `PROCESSING_DELAY_MS` | `0` | Artificial processing delay for experiments |

The MongoDB client uses retryable writes and majority acknowledgement for accepted events. Connection pools are per process: total potential connections are approximately `(API replicas + worker replicas) × MONGO_POOL_SIZE`, so tune pool size and replica count together.

## Scalability: what to measure

This project is intended to make the bottlenecks observable, not hide them behind abstractions.

Start with one API and one worker, establish a baseline, then increase API replicas, worker replicas, and worker concurrency independently. Measure:

- offered requests/sec versus accepted requests/sec;
- API p50/p95/p99 latency and MongoDB write latency;
- pending queue depth and oldest-event age;
- processed events/sec and end-to-end processing latency;
- duplicate rate, retry rate, lease takeovers, and dead-letter count;
- MongoDB CPU, disk IOPS, replication lag, and connection-pool saturation.

A high event rate also depends on payload size, indexes, write concern, hardware, replication, hot-key distribution, and the downstream processor. `PROCESSING_DELAY_MS=0` measures the ingestion/claim path without simulated downstream latency; it is not a substitute for a realistic end-to-end benchmark.

At billions of events per day (about 11.6k events/sec on average) or millions per minute (at least 16.7k events/sec), this single-collection polling queue may no longer be the right architecture. A partitioned durable log such as Kafka, keyed by `patientId`, is a likely next step. The event contract, deduplication identity, per-patient ordering rule, and worker idempotency remain relevant even if the transport and storage change.

## Deliberate omissions

No generic repository, event bus abstraction, custom framework, dashboard, or speculative microservices. The only infrastructure here is the minimum needed to demonstrate durable acceptance, deduplication, patient-level ordering, competing workers, retries, and recovery. Complexity should be added only when a benchmark or a correctness requirement demonstrates the need.
