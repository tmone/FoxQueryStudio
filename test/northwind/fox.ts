// Reference implementations of FoxPro functions, written from the documented
// Visual FoxPro 9 behaviour. They compute the expected results directly from the
// .dbf data, independently of the converter and of SQL Server.

const MS_PER_DAY = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');

export const alltrim = (s: string) => s.replace(/^ +| +$/g, '');
export const rtrim = (s: string) => s.replace(/ +$/, '');
export const ltrim = (s: string) => s.replace(/^ +/, '');

/** Case mapping that never changes the string length (FoxPro keeps ß as is). */
const mapCase = (s: string, map: (ch: string) => string) => [...s].map((ch) => (map(ch).length === 1 ? map(ch) : ch)).join('');
export const upper = (s: string) => mapCase(s, (ch) => ch.toUpperCase());
export const lower = (s: string) => mapCase(s, (ch) => ch.toLowerCase());

export const substr = (s: string, start: number, length?: number) => s.slice(start - 1, length === undefined ? undefined : start - 1 + length);
export const left = (s: string, n: number) => s.slice(0, n);
export const right = (s: string, n: number) => (n >= s.length ? s : s.slice(s.length - n));
/** Case-sensitive position, 0 when absent. */
export const at = (search: string, s: string) => s.indexOf(search) + 1;
export const atc = (search: string, s: string) => s.toLowerCase().indexOf(search.toLowerCase()) + 1;
export const contains = (needle: string, haystack: string) => haystack.includes(needle);
export const strtran = (s: string, from: string, to = '') => s.split(from).join(to);

/** Longer values are cut to the leftmost `n` characters; the fill pattern starts at the left edge. */
export function padl(value: string | number, n: number, fill = ' '): string {
  const s = String(value);
  return s.length >= n ? s.slice(0, n) : fill.repeat(n).slice(0, n - s.length) + s;
}

export function padr(value: string | number, n: number, fill = ' '): string {
  const s = String(value);
  return s.length >= n ? s.slice(0, n) : s + fill.repeat(n).slice(0, n - s.length);
}

/** Rounds half away from zero, as FoxPro does. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return (Math.sign(value) * Math.round(Math.abs(value) * factor + 1e-7)) / factor;
}

/** Right-aligned number; asterisks when it does not fit. */
export function str(value: number, length = 10, decimals = 0): string {
  const text = round(value, decimals).toFixed(decimals);
  return text.length > length ? '*'.repeat(length) : text.padStart(length);
}

export const int = (n: number) => Math.trunc(n);
/** The result takes the sign of the divisor. */
export const mod = (a: number, b: number) => ((a % b) + b) % b;

export const year = (d: Date) => d.getUTCFullYear();
export const month = (d: Date) => d.getUTCMonth() + 1;
export const day = (d: Date) => d.getUTCDate();
/** 1 = Sunday. */
export const dow = (d: Date) => d.getUTCDay() + 1;
export const dtos = (d: Date) => `${year(d)}${pad2(month(d))}${pad2(day(d))}`;
/** SET DATE DMY, SET CENTURY ON. */
export const dtoc = (d: Date) => `${pad2(day(d))}/${pad2(month(d))}/${year(d)}`;
export const date = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * MS_PER_DAY);
export const addSeconds = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);
export const daysBetween = (later: Date, earlier: Date) => Math.round((later.getTime() - earlier.getTime()) / MS_PER_DAY);

/** Moves by whole months, clamping to the last day of the target month. */
export function gomonth(d: Date, months: number): Date {
  const first = new Date(Date.UTC(year(d), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day(d), lastDay)));
}

/** Blank, zero or false. NULL is not empty: EMPTY(.NULL.) is .F. in FoxPro. */
export function empty(value: string | number | boolean | Date | null): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'boolean') return !value;
  return false;
}
