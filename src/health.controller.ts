import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.service';

@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  async health() {
    await this.database.events.countDocuments({ kind: 'event' }, { limit: 1 });
    return { status: 'ok' };
  }

  @Get('stats')
  async stats() {
    const statuses = [
      'pending',
      'processing',
      'processed',
      'dead_letter',
      'needs_reconciliation',
    ] as const;
    const counts = await Promise.all(
      statuses.map((status) => this.database.events.countDocuments({ kind: 'event', status })),
    );
    return Object.fromEntries(statuses.map((status, index) => [status, counts[index]]));
  }
}
