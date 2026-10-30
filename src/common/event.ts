export interface PatientEvent {
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

export type EventStatus = 'pending' | 'processing' | 'processed' | 'dead_letter';

export interface EventDocument extends PatientEvent {
  _id: string;
  kind: 'event';
  fingerprint: string;
  status: EventStatus;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
  leaseUntil?: Date;
}
