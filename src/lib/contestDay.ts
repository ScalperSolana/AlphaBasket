import { ENV } from "@/env";

export const CONTEST_DAY_MS = 86_400_000;
export const CONTEST_DAY_BOUNDARY_OFFSET_MS = ENV.CONTEST_DAY_BOUNDARY_OFFSET_MS;

export const getContestDayIdFromTimestamp = (timestampMs: number): string =>
  Math.floor((timestampMs - CONTEST_DAY_BOUNDARY_OFFSET_MS) / CONTEST_DAY_MS).toString();

export const getContestDayIdFromDate = (date: Date): string =>
  getContestDayIdFromTimestamp(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0),
  );

export const getContestDayStartTimestamp = (dayId: string | number | bigint): number =>
  Number(dayId) * CONTEST_DAY_MS + CONTEST_DAY_BOUNDARY_OFFSET_MS;

export const getContestDayStartDate = (dayId: string | number | bigint): Date =>
  new Date(getContestDayStartTimestamp(dayId));
