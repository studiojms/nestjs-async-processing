import { Body, Controller, Post } from '@nestjs/common';
import { CreateEventDto } from './create-event.dto';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  async create(@Body() event: CreateEventDto) {
    return { ...(await this.events.accept(event)), status: 'accepted' };
  }
}
