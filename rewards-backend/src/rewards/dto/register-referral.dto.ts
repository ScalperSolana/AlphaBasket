import { IsString, MaxLength } from 'class-validator';

export class RegisterReferralDto {
  @IsString()
  @MaxLength(128)
  referrer: string;

  @IsString()
  @MaxLength(128)
  friend: string;
}
