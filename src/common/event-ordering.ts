import { EventDocument } from './event';

export type EventOrderKey = Pick<EventDocument, 'eventTime' | 'fingerprint'>;

export function compareEventOrder(left: EventOrderKey, right: EventOrderKey): number {
  const timeDifference = left.eventTime.getTime() - right.eventTime.getTime();
  return timeDifference || left.fingerprint.localeCompare(right.fingerprint);
}
