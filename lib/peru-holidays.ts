/**
 * lib/peru-holidays.ts — calendario de feriados NACIONALES de Perú.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ ESTÁ VERSIONADO Y NO SE CONSULTA UNA API
 *
 *  El plazo del Libro de Reclamaciones se cuenta en días hábiles. Si el
 *  calendario se consultara a un servicio externo en runtime, una caída o un
 *  cambio silencioso alteraría fechas legales ya comunicadas al consumidor.
 *  Acá el calendario es código revisable, con versión y tests.
 *
 *  · Solo feriados NACIONALES (D.L. 713, art. 6, y sus modificatorias).
 *  · NO incluye feriados regionales ni días no laborables compensables: no
 *    detienen el plazo para todo el país y no aplican a la sede de atención.
 *  · Los feriados peruanos NO se trasladan: se toman en la fecha exacta.
 *  · `PERU_HOLIDAYS` (opcional) agrega feriados declarados por decreto después
 *    de este release. No reemplaza el calendario ni marca un año como completo.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  AÑO SIN CALENDARIO (FAIL-SAFE)
 *
 *  Si un año no está en `CALENDARS`, `isPeruHoliday` devuelve `false` y
 *  `peruHolidayCalendarStatus` lo reporta en `missingYears`. El vencimiento se
 *  calcula solo con sábados y domingos, es decir, puede quedar ANTES del plazo
 *  legal máximo: nunca después. La bandeja de admin muestra la advertencia y
 *  `LIBRO_RECLAMACIONES.md` explica cómo cargar el año siguiente.
 */

export const PERU_HOLIDAY_CALENDAR_VERSION = '2026-2027.1';

export interface PeruHoliday {
  /** Fecha local de Lima, `YYYY-MM-DD`. */
  date: string;
  name: string;
}

const CALENDARS: Readonly<Record<number, readonly PeruHoliday[]>> = {
  2026: [
    { date: '2026-01-01', name: 'Año Nuevo' },
    { date: '2026-04-02', name: 'Jueves Santo' },
    { date: '2026-04-03', name: 'Viernes Santo' },
    { date: '2026-05-01', name: 'Día del Trabajo' },
    { date: '2026-06-07', name: 'Batalla de Arica y Día de la Bandera' },
    { date: '2026-06-29', name: 'San Pedro y San Pablo' },
    { date: '2026-07-23', name: 'Día de la Fuerza Aérea del Perú' },
    { date: '2026-07-28', name: 'Fiestas Patrias' },
    { date: '2026-07-29', name: 'Fiestas Patrias' },
    { date: '2026-08-06', name: 'Batalla de Junín' },
    { date: '2026-08-30', name: 'Santa Rosa de Lima' },
    { date: '2026-10-08', name: 'Combate de Angamos' },
    { date: '2026-11-01', name: 'Día de Todos los Santos' },
    { date: '2026-12-08', name: 'Inmaculada Concepción' },
    { date: '2026-12-09', name: 'Batalla de Ayacucho' },
    { date: '2026-12-25', name: 'Navidad' },
  ],
  2027: [
    { date: '2027-01-01', name: 'Año Nuevo' },
    { date: '2027-03-25', name: 'Jueves Santo' },
    { date: '2027-03-26', name: 'Viernes Santo' },
    { date: '2027-05-01', name: 'Día del Trabajo' },
    { date: '2027-06-07', name: 'Batalla de Arica y Día de la Bandera' },
    { date: '2027-06-29', name: 'San Pedro y San Pablo' },
    { date: '2027-07-23', name: 'Día de la Fuerza Aérea del Perú' },
    { date: '2027-07-28', name: 'Fiestas Patrias' },
    { date: '2027-07-29', name: 'Fiestas Patrias' },
    { date: '2027-08-06', name: 'Batalla de Junín' },
    { date: '2027-08-30', name: 'Santa Rosa de Lima' },
    { date: '2027-10-08', name: 'Combate de Angamos' },
    { date: '2027-11-01', name: 'Día de Todos los Santos' },
    { date: '2027-12-08', name: 'Inmaculada Concepción' },
    { date: '2027-12-09', name: 'Batalla de Ayacucho' },
    { date: '2027-12-25', name: 'Navidad' },
  ],
};

/** Años con calendario completo revisado. Orden ascendente. */
export function peruHolidayCalendarYears(): number[] {
  return Object.keys(CALENDARS)
    .map(Number)
    .sort((a, b) => a - b);
}

export function isPeruHolidayYearConfigured(year: number): boolean {
  return Number.isInteger(year) && Object.prototype.hasOwnProperty.call(CALENDARS, year);
}

/** Feriados del año, o `null` si el año aún no está cargado. */
export function getPeruHolidays(year: number): readonly PeruHoliday[] | null {
  return isPeruHolidayYearConfigured(year) ? (CALENDARS[year] ?? null) : null;
}

export function peruHolidayName(isoDay: string): string | null {
  const year = Number(isoDay.slice(0, 4));
  const holidays = getPeruHolidays(year);
  if (!holidays) return null;
  return holidays.find((holiday) => holiday.date === isoDay)?.name ?? null;
}

/**
 * ¿Es feriado nacional? Los `extraHolidays` son fechas oficiales agregadas por
 * decreto después del release (variable `PERU_HOLIDAYS`). Se validan al parsear.
 */
export function isPeruHoliday(isoDay: string, extraHolidays?: Iterable<string>): boolean {
  if (peruHolidayName(isoDay) !== null) return true;
  if (!extraHolidays) return false;
  for (const date of extraHolidays) {
    if (date === isoDay) return true;
  }
  return false;
}

function isValidIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Parsea `PERU_HOLIDAYS`: fechas `YYYY-MM-DD` separadas por coma, espacio,
 * punto y coma o salto de línea. Ignora vacíos y reporta los inválidos; no
 * inventa fechas ni completa años.
 */
export function parsePeruHolidayList(raw: string | undefined | null): {
  dates: string[];
  invalid: string[];
} {
  if (!raw) return { dates: [], invalid: [] };

  const dates = new Set<string>();
  const invalid: string[] = [];

  for (const token of raw.split(/[\s,;]+/)) {
    const value = token.trim();
    if (!value) continue;
    if (isValidIsoDay(value)) dates.add(value);
    else invalid.push(value);
  }

  return { dates: [...dates].sort(), invalid };
}

export interface PeruHolidayCalendarStatus {
  version: string;
  /** Años consultados que sí tienen calendario. */
  configuredYears: number[];
  /** Años consultados sin calendario: el cómputo usa solo lunes–viernes. */
  missingYears: number[];
}

/** Estado de cobertura para los años que atraviesa un plazo. */
export function peruHolidayCalendarStatus(years: Iterable<number>): PeruHolidayCalendarStatus {
  const unique = [...new Set(years)].filter(Number.isInteger).sort((a, b) => a - b);
  return {
    version: PERU_HOLIDAY_CALENDAR_VERSION,
    configuredYears: unique.filter((year) => isPeruHolidayYearConfigured(year)),
    missingYears: unique.filter((year) => !isPeruHolidayYearConfigured(year)),
  };
}
