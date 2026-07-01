import { formatInTimeZone } from "date-fns-tz";

const TZ = "Australia/Sydney";

export function formatDate(value?: string | Date | null): string {
  if (!value) return "Never";
  try {
    return formatInTimeZone(new Date(value as string), TZ, "dd.MM.yyyy");
  } catch {
    return String(value);
  }
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return "Never";
  try {
    return formatInTimeZone(new Date(value as string), TZ, "dd.MM.yyyy HH:mm");
  } catch {
    return String(value);
  }
}
