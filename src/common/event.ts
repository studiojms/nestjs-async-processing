import { Document } from 'mongodb';

export interface PatientEvent {
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

export type EventStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'dead_letter'
  | 'needs_reconciliation';

export interface EventDocument extends Document, PatientEvent {
  _id: string;
  kind: 'event';
  fingerprint: string;
  eventTime: Date;
  status: EventStatus;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
  leaseUntil?: Date;
  leaseOwner?: string;
  claimToken?: string;
  processedAt?: Date;
  reconciliationReason?: string;
}

export interface PatientLockDocument extends Document {
  _id: string;
  kind: 'patient_lock';
  patientId: string;
  blocked: boolean;
  owner?: string;
  lockToken?: string;
  expiresAt?: Date;
  createdAt: Date;
}

// Both document kinds deliberately use string IDs in the shared collection.
// Keep this boundary explicit so MongoDB does not infer ObjectId for _id.
export interface EventsCollectionRecord extends Document {
  _id: string;
}

export interface ClaimedEvent {
  event: EventDocument;
  patientLockId: string;
  lockToken: string;
  claimToken: string;
}
