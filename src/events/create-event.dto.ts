import { IsDateString, IsNotEmpty, IsObject, IsString } from 'class-validator';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  patientId!: string;

  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsObject()
  data!: Record<string, unknown>;

  @IsDateString()
  ts!: string;
}
