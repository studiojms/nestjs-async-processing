import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';

@Module({ imports: [DatabaseModule, EventsModule], controllers: [HealthController] })
export class ApiModule {}
