import { IsNumber, IsPositive, IsString, MaxLength } from 'class-validator';

export class ManualGrantDto {
  @IsString()
  @MaxLength(128)
  wallet: string;

  @IsNumber()
  @IsPositive()
  amountVara: number;

  @IsString()
  @MaxLength(128)
  grantId: string;

  @IsString()
  @MaxLength(256)
  reason: string;
}
