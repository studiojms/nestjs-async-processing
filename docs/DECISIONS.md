# Decisions

1. **Keep the boundary immutable.** The sender contract is exactly `patientId`, `type`, `data`, and `ts`.
2. **Fingerprint is identity.** Canonical JSON + SHA-256 plus a unique MongoDB index gives concurrency-safe deduplication. Trade-off: identical payloads merge; changed retries do not.
3. **MongoDB is the exercise queue.** It avoids an additional broker and keeps the experiment easy to run. It is not the recommended default for a billion events/day.
4. **Patient is the ordering key.** A renewable lease serializes a patient's stream while allowing different patients to run in parallel.
5. **At-least-once processing.** A worker can repeat work after lease expiry or crash. Real downstream effects must be idempotent. This sample simulates processing only.
6. **Optimize from measurements.** Keep process concurrency bounded; scale API and workers separately; replace polling with a partitioned log when MongoDB queue contention becomes the bottleneck.
