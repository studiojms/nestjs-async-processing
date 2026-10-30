# Patient event ingestion (minimal NestJS)

A deliberately small implementation of the patient-event ingestion exercise. The code favors a short, inspectable path over a framework of abstractions.

## Contract

`POST /events` accepts exactly these fields and no idempotency header:

```json
{"patientId":"p-1","type":"observation","data":{"value":72},"ts":"2026-10-30T12:00:00.000Z"}
```

The API validates the body, calculates a SHA-256 fingerprint of canonical JSON, and inserts the event into MongoDB. It returns `202` only after the write is acknowledged. A unique index makes duplicate detection safe across API replicas. Identical payloads are intentionally considered the same logical event. Without a sender-provided event ID, two distinct events with identical four fields cannot be distinguished.

## Processing model

MongoDB is both the durable queue and coordination store; this exercise intentionally adds no broker. The `events` collection contains event documents and short-lived patient lease documents. A worker obtains a lease for one patient, then atomically claims that patient's earliest eligible event. Different patients can progress concurrently; one patient's events are serialized. Expired leases and processing claims can be recovered by another worker. Transient errors are retried with a bounded attempt count; exhausted events are marked `dead_letter` and stop that patient's stream.

This is a simple benchmarkable baseline, not a claim that MongoDB polling is the right billion-events/day architecture. At that scale, partitioned durable messaging (for example Kafka) and partition keys based on `patientId` are usually the more natural design. The exercise keeps MongoDB as the only durable component so the ingestion and coordination behavior can be measured without introducing broker operations.

## Run

Requires Node.js 22+, npm, and Docker Compose.

```bash
cp .env.example .env
docker compose up --build --scale worker=3
```

API: `http://localhost:3000`

```bash
curl -i http://localhost:3000/events \
  -H 'content-type: application/json' \
  -d '{"patientId":"p-1","type":"observation","data":{"value":72},"ts":"2026-10-30T12:00:00.000Z"}'
```

Useful endpoints: `GET /health`, `GET /stats`.

## Development

```bash
npm ci
npm test
npm run lint
npm run build
```

The tests cover canonical identity, input validation, and the core patient-ordering rule. Set `MONGODB_URI` to a MongoDB instance for API/worker execution.

## Scaling notes

- Scale API and worker processes independently.
- Keep `patientId` as the partition/serialization key. A hot patient is inherently serialized by the ordering requirement; adding workers cannot make one patient's ordered stream parallel.
- Bound concurrency and MongoDB connection pools per process. Total load is replicas × per-process limits.
- Measure sustained offered rate, accepted rate, queue age/depth, processing latency, retry rate, and database saturation. A benchmark number without machine, replica, and durability settings is not meaningful.
- At very high rates, avoid unbounded polling and index/partition the queue deliberately. Move to a partitioned log/broker when the workload outgrows database polling.

## Deliberate omissions

No generic repository layer, event bus abstraction, custom result monads, elaborate configuration framework, dashboards, or speculative microservices. Add complexity only when a measured requirement needs it.
