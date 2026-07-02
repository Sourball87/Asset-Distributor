const TZ = "Australia/Sydney";

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: TZ,
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TZ,
});

function toParts(formatter: Intl.DateTimeFormat, value: string | Date): string {
  const parts = formatter.formatToParts(typeof value === "string" ? new Date(value) : value);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.day}.${p.month}.${p.year}`;
}

export function formatDate(value?: string | Date | null): string {
  if (!value) return "Never";
  try {
    return toParts(dateFormatter, value);
  } catch {
    return String(value);
  }
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return "Never";
  try {
    const parts = dateTimeFormatter.formatToParts(
      typeof value === "string" ? new Date(value) : value
    );
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
  } catch {
    return String(value);
  }
}
