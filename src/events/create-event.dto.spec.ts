import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from './create-event.dto';

describe('CreateEventDto', () => {
  it('accepts the four-field event contract', async () => {
    const dto = plainToInstance(CreateEventDto, { patientId: 'p1', type: 'vital', data: {}, ts: 'now' });
    expect(await validate(dto)).toHaveLength(0);
  });
  it('rejects missing fields and invalid data', async () => {
    const dto = plainToInstance(CreateEventDto, { patientId: 'p1', type: 'vital', data: 'no', ts: '' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
