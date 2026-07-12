export function timestamp(epochMillis: number, timeZone?: string): Date {
  if (!timeZone) {
    return new Date(epochMillis);
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(epochMillis));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const yyyy = get('year');
  const MM = get('month');
  const dd = get('day');
  const HH = get('hour');
  const mm = get('minute');
  const ss = get('second');
  const SSS = get('fractionalSecond');
  const iso = `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}.${SSS}${getOffset(timeZone, epochMillis)}`;
  return new Date(iso);
}

function getOffset(timeZone: string, epochMillis: number): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  });
  const parts = dtf.formatToParts(new Date(epochMillis));
  const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? '+00:00';
  const match = /GMT([+\-]\d{1,2}):?(\d{2})?/.exec(offset);
  if (!match) return '+00:00';
  const sign = match[1]!.startsWith('-') ? '-' : '+';
  const hours = match[1]!.replace(/[+\-]/, '').padStart(2, '0');
  const minutes = match[2] ?? '00';
  return `${sign}${hours}:${minutes}`;
}
