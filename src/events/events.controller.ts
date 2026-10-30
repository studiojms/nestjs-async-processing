import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CreateEventDto } from './create-event.dto';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Body() event: CreateEventDto) {
    return { ...(await this.events.accept(event)), status: 'accepted' };
  }
}
