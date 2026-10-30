# Design decisions

## Keep the ingest path short

The HTTP path validates, fingerprints, inserts, and acknowledges. It does not call the processor and does not wait for downstream work. The normal path is one database write; on duplicate-key error the API reads the existing event. MongoDB's unique fingerprint index, not an application-level read-before-write check, guarantees deduplication across API replicas.

## Use one durable store for this experiment

MongoDB stores events and patient leases. This avoids introducing a broker before measuring the workload. It also makes MongoDB the likely first bottleneck; the README describes the measurements and the likely partitioned-log evolution.

## Make the stream key explicit

`patientId` is the serialization key. A worker must acquire the patient's lease before claiming its earliest unresolved event. Workers may process different patients concurrently; events within one patient remain serial.

## Fence stale workers

The patient lease reduces concurrent claims. The per-event `claimToken` prevents a worker whose lease was lost from updating an event reclaimed by another worker. Both leases are renewed during processing. External side effects still need idempotency because a process can crash after the side effect and before the completion write.

## Do not silently reorder late events

Events are sorted by parsed timestamp, then fingerprint. If a newly accepted event sorts before the latest processed event, it is marked `needs_reconciliation` and blocks the stream. The baseline does not implement automatic downstream rollback or replay.

## Keep MongoDB types honest

Event and patient-lock documents share a collection and both use string `_id` values. The TypeScript collection schema explicitly represents both document kinds. For MongoDB Node driver 6, `findOneAndUpdate` opts into the direct document return with `includeResultMetadata: false`.

## Durability is part of acceptance

The client uses retryable writes and majority write acknowledgement. The API responds with `202` only after the event insert succeeds. An HTTP timeout can still leave the client uncertain whether the write committed; a retry with the same payload resolves that ambiguity through the fingerprint index.


## TTL cleanup

MongoDB TTL indexes must use a single indexed field. The patient-lock cleanup index therefore targets `expiresAt` only and uses a partial filter for `{ kind: 'patient_lock', blocked: false }`. It is cleanup, not lease correctness: workers always check `expiresAt` in the lock query, and blocked locks have no expiry and are never removed by TTL.
