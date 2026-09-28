const berlinTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function berlinDateTimeInput(value: string): string {
  const parts = Object.fromEntries(berlinTime.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * A browser-local Date would shift the course for managers outside Berlin.
 * Reject nonexistent and ambiguous wall times around daylight saving changes.
 */
export function berlinDateTimeIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = [1, 2]
    .map(offset => new Date(wallTime - offset * 60 * 60 * 1000))
    .filter(candidate => berlinDateTimeInput(candidate.toISOString()) === value);
  return candidates.length === 1 ? candidates[0].toISOString() : null;
}