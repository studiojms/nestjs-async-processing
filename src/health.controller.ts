import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.service';

@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}
  @Get('health') async health() {
    await this.database.events.countDocuments({ kind: 'event' }, { limit: 1 });
    return { status: 'ok' };
  }
  @Get('stats') async stats() {
    const [pending, processing, processed, deadLetter] = await Promise.all([
      'pending', 'processing', 'processed', 'dead_letter',
    ].map((status) => this.database.events.countDocuments({ kind: 'event', status })));
    return { pending, processing, processed, deadLetter };
  }
}
