'use client';

/**
 * LocationPicker — asistente de ubicación de una tienda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  FLUJO (mobile-first, un paso a la vez)
 *
 *    1. Departamento → Provincia → Distrito   (selects dependientes, datos INEI)
 *    2. Dirección + referencia + "Usar mi ubicación actual"
 *    3. Resumen de lo que se va a guardar + mapa con pin → "Confirmar esta ubicación"
 *
 *  REGLAS QUE NO SE NEGOCIAN
 *
 *  · El UBIGEO es la referencia canónica: los nombres los deriva la base.
 *  · El único dato geográfico que se guarda es el pin (lat/lng).
 *  · GPS y geocoder SOLO PROPONEN un distrito: si detectan otro, se muestra una
 *    confirmación con «Usar esta ubicación» / «Mantener mi selección». Nunca se
 *    reescriben los selects en silencio (ver lib/store-location-wizard.ts).
 *  · Antes de guardar se muestra siempre el resumen (departamento, provincia,
 *    distrito, dirección y pin) con la misma data que se enviará.
 *  · Guarda UBIGEO ↔ pin: lejos → confirmación explícita; a cientos de km → no
 *    se puede confirmar hasta mover el marcador o cambiar el distrito.
 *  · Si el pin lo puso el GPS o el geocoder y el usuario lo mueve, el origen
 *    pasa a `map_pin`: refleja que hubo ajuste manual.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '@/components/i18n/I18nProvider';
import { MapCanvas } from '@/components/map/MapCanvas';
import {
  buildDistrictSuggestion,
  buildLocationSummary,
  buildLocationValue,
  evaluatePinDistance,
  resolveSuggestionChoice,
  type DistrictSelection,
  type DistrictSuggestion,
  type StoreLocationValue,
} from '@/lib/store-location-wizard';

export type { StoreLocationValue };

interface UbigeoDepartment {
  code: string;
  name: string;
}
interface UbigeoProvince {
  code: string;
  name: string;
}
interface UbigeoDistrict {
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

interface Props {
  /** Valores actuales (edición de una tienda ya ubicada). */
  initial?: Partial<StoreLocationValue> | null;
  submitLabel?: string;
  /** Persiste el valor. Devuelve un mensaje de error o undefined si fue bien. */
  onSubmit: (value: StoreLocationValue) => Promise<string | undefined>;
  /** Onboarding: permite guardar el valor junto con el resto del alta. */
  onValueChange?: (value: StoreLocationValue | null) => void;
  /** Onboarding: no muestra el botón de guardar (lo hace el formulario padre). */
  hideSubmit?: boolean;
}

type Step = 1 | 2 | 3;
type Status =
  | { kind: 'info' | 'warn' | 'error'; message: string }
  | null;

const DEPARTMENTS_URL = '/api/geo/ubigeo';

export function LocationPicker({ initial, submitLabel, onSubmit, onValueChange, hideSubmit }: Props) {
  const { t } = useI18n();

  const [step, setStep] = useState<Step>(1);
  const [departments, setDepartments] = useState<UbigeoDepartment[]>([]);
  const [provinces, setProvinces] = useState<UbigeoProvince[]>([]);
  const [districts, setDistricts] = useState<UbigeoDistrict[]>([]);

  const [department, setDepartment] = useState(initial?.ubigeo ? initial.ubigeo.slice(0, 2) : '');
  const [province, setProvince] = useState(initial?.ubigeo ? initial.ubigeo.slice(0, 4) : '');
  const [district, setDistrict] = useState(initial?.ubigeo ?? '');

  const [address, setAddress] = useState(initial?.address ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [marker, setMarker] = useState<{ latitude: number; longitude: number } | null>(
    typeof initial?.latitude === 'number' && typeof initial?.longitude === 'number'
      ? { latitude: initial.latitude, longitude: initial.longitude }
      : null,
  );
  const [source, setSource] = useState<StoreLocationValue['source']>('map_pin');

  /** Sugerencia pendiente de aceptar (GPS o geocoder). No cambia la selección. */
  const [suggestion, setSuggestion] = useState<DistrictSuggestion | null>(null);
  /** El usuario confirmó un pin del tramo intermedio de la guarda. */
  const [farConfirmed, setFarConfirmed] = useState(false);

  const [status, setStatus] = useState<Status>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [geocodeBusy, setGeocodeBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const mapRef = useRef<HTMLDivElement | null>(null);

  const selectedDistrict = useMemo(
    () => districts.find((item) => item.code === district) ?? null,
    [districts, district],
  );

  const districtCentroid = useMemo(() => {
    if (!selectedDistrict || selectedDistrict.latitude === null || selectedDistrict.longitude === null) {
      return null;
    }
    return { latitude: selectedDistrict.latitude, longitude: selectedDistrict.longitude };
  }, [selectedDistrict]);

  // ── Catálogo ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch(DEPARTMENTS_URL, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { departments?: UbigeoDepartment[] } | null) => {
        if (!cancelled && payload?.departments) setDepartments(payload.departments);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!department) return;
    let cancelled = false;
    fetch(`${DEPARTMENTS_URL}?department=${department}`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { provinces?: UbigeoProvince[] } | null) => {
        if (!cancelled) setProvinces(payload?.provinces ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [department]);

  useEffect(() => {
    if (!province) return;
    let cancelled = false;
    fetch(`${DEPARTMENTS_URL}?province=${province}`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { districts?: UbigeoDistrict[] } | null) => {
        if (!cancelled) setDistricts(payload?.districts ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [province]);

  // Sin pin propio, se muestra el centroide del distrito: es solo una vista
  // previa. El usuario lo confirma moviéndolo o guardando (queda 'map_pin').
  const effectiveMarker = marker ?? districtCentroid;

  // La guarda necesita el centroide, que llega con el catálogo del distrito.
  // Sin ese dato no se puede comparar, así que tampoco se habilita el guardado.
  const districtReady = selectedDistrict !== null;

  const pinVerdict = useMemo(
    () =>
      effectiveMarker
        ? evaluatePinDistance(districtCentroid, effectiveMarker, { confirmed: farConfirmed })
        : evaluatePinDistance(null, { latitude: 0, longitude: 0 }),
    [districtCentroid, effectiveMarker, farConfirmed],
  );

  const value = useMemo<StoreLocationValue | null>(() => {
    if (!districtReady || !effectiveMarker) return null;
    return buildLocationValue({
      ubigeo: district,
      address,
      reference,
      marker: effectiveMarker,
      // Si el usuario movió el marcador, `onMarkerChange` ya lo dejó en map_pin.
      source: marker ? source : 'map_pin',
      pin: pinVerdict,
    });
  }, [districtReady, effectiveMarker, district, address, reference, marker, source, pinVerdict]);

  // Resumen: mismas piezas y mismo pin que el payload.
  const summary = useMemo(
    () =>
      buildLocationSummary({
        ubigeo: district,
        address,
        marker: districtReady ? effectiveMarker : null,
        names: {
          department: departments.find((item) => item.code === department)?.name ?? null,
          province: provinces.find((item) => item.code === province)?.name ?? null,
          district: selectedDistrict?.name ?? null,
        },
      }),
    [district, address, districtReady, effectiveMarker, departments, department, provinces, province, selectedDistrict],
  );

  const onChangeRef = useRef(onValueChange);
  useEffect(() => {
    onChangeRef.current = onValueChange;
  }, [onValueChange]);
  useEffect(() => {
    onChangeRef.current?.(value);
  }, [value]);

  /** Cambia la selección SOLO cuando el usuario lo pide explícitamente. */
  const chooseSuggestion = useCallback(
    (choice: 'use' | 'keep') => {
      const selection: DistrictSelection = { department, province, district };
      const next = resolveSuggestionChoice(selection, suggestion, choice);
      setSuggestion(null);
      setFarConfirmed(false);

      if (choice === 'keep') return;

      setDepartment(next.department);
      setProvince(next.province);
      setDistrict(next.district);
      setStatus({ kind: 'info', message: t('location.districtChanged') });
    },
    [department, province, district, suggestion, t],
  );

  // ── Acciones ───────────────────────────────────────────────────────────────

  const takeGpsLocation = async () => {
    if (gpsBusy) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus({ kind: 'warn', message: t('location.gpsUnsupported') });
      return;
    }

    setGpsBusy(true);
    setStatus(null);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12_000,
          maximumAge: 30_000,
        });
      });

      const point = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };

      const response = await fetch('/api/geo/reverse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(point),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            address?: string | null;
            ubigeo?: {
              code?: string | null;
              district?: string | null;
              province?: string | null;
              department?: string | null;
            } | null;
            code?: string;
          }
        | null;

      if (!response.ok) {
        // El GPS sí sirvió aunque el geocoder no: el pin queda donde está.
        setMarker(point);
        setSource('gps');
        setStatus({
          kind: 'warn',
          message:
            payload?.code === 'geocoder_unavailable'
              ? t('location.geocoderUnavailable')
              : t('location.gpsNoAddress'),
        });
        return;
      }

      setMarker(point);
      setSource('gps');

      if (payload?.address) {
        setAddress((current) => (current.trim().length >= 3 ? current : (payload.address as string)));
      }

      // El distrito detectado NO se aplica solo: se propone y el usuario decide.
      const proposal = buildDistrictSuggestion({
        source: 'gps',
        currentUbigeo: district,
        detected: payload?.ubigeo ?? null,
      });
      if (proposal) {
        setSuggestion(proposal);
        setStatus(null);
        return;
      }

      setStatus({ kind: 'info', message: t('location.gpsApplied') });
    } catch {
      setStatus({ kind: 'warn', message: t('location.gpsDenied') });
    } finally {
      setGpsBusy(false);
    }
  };

  const locateOnMap = async () => {
    if (geocodeBusy) return;
    if (!/^[0-9]{6}$/.test(district)) {
      setStatus({ kind: 'error', message: t('location.needDistrict') });
      return;
    }
    if (address.trim().length < 3) {
      setStatus({ kind: 'error', message: t('location.needAddress') });
      return;
    }

    setGeocodeBusy(true);
    setStatus(null);
    try {
      const response = await fetch('/api/geo/geocode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), ubigeo: district }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            code?: string;
            hit?: {
              point: { latitude: number; longitude: number };
              confidence: 'high' | 'low';
              ubigeo?: string | null;
              district?: string | null;
              province?: string | null;
              department?: string | null;
            } | null;
          }
        | null;

      if (!response.ok) {
        setStatus({
          kind: 'warn',
          message:
            payload?.code === 'geocoder_unavailable'
              ? t('location.geocoderUnavailable')
              : t('location.notFound'),
        });
        setStep(3);
        return;
      }

      if (!payload?.hit) {
        setStatus({ kind: 'warn', message: t('location.notFound') });
        setStep(3);
        return;
      }

      setMarker(payload.hit.point);
      setSource('geocoder');

      // Igual que el GPS: el geocoder sugiere, nunca cambia el UBIGEO.
      const proposal = buildDistrictSuggestion({
        source: 'geocoder',
        currentUbigeo: district,
        detected: {
          code: payload.hit.ubigeo ?? null,
          district: payload.hit.district ?? null,
          province: payload.hit.province ?? null,
          department: payload.hit.department ?? null,
        },
      });
      if (proposal) setSuggestion(proposal);

      setStatus(
        payload.hit.confidence === 'high' && !proposal
          ? null
          : { kind: 'warn', message: t('location.lowConfidence') },
      );
      setStep(3);
    } catch {
      setStatus({ kind: 'warn', message: t('location.notFound') });
      setStep(3);
    } finally {
      setGeocodeBusy(false);
    }
  };

  const submit = async () => {
    if (saving) return;
    if (!value) {
      setStatus({ kind: 'error', message: t('location.incomplete') });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const error = await onSubmit(value);
      if (error) setStatus({ kind: 'error', message: error });
    } finally {
      setSaving(false);
    }
  };

  const canContinueStep1 = /^[0-9]{6}$/.test(district);
  const canContinueStep2 = address.trim().length >= 3;

  return (
    <section
      aria-label={t('location.title')}
      className="rounded-2xl border border-border bg-surface p-4"
    >
      <header>
        <h3 className="text-base font-semibold text-primary">{t('location.title')}</h3>
        <p className="mt-1 text-sm text-secondary">{t('location.intro')}</p>
        <p className="mt-2 text-xs uppercase tracking-[2px] text-tertiary">
          {t('location.stepCounter', { current: step, total: 3 })}
        </p>
      </header>

      <div className="mt-4">
        {step === 1 && (
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-primary">{t('location.step1Title')}</h4>

            <label className="block text-xs text-tertiary">
              {t('location.department')}
              <select
                value={department}
                onChange={(event) => {
                  setDepartment(event.target.value);
                  setProvince('');
                  setDistrict('');
                  setDistricts([]);
                  setMarker(null);
                  setSuggestion(null);
                  setFarConfirmed(false);
                }}
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary"
              >
                <option value="">{t('location.selectDepartment')}</option>
                {departments.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-tertiary">
              {t('location.province')}
              <select
                value={province}
                disabled={!department}
                onChange={(event) => {
                  setProvince(event.target.value);
                  setDistrict('');
                  setMarker(null);
                  setSuggestion(null);
                  setFarConfirmed(false);
                }}
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary disabled:opacity-50"
              >
                <option value="">{t('location.selectProvince')}</option>
                {provinces.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-tertiary">
              {t('location.district')}
              <select
                value={district}
                disabled={!province}
                onChange={(event) => {
                  setDistrict(event.target.value);
                  setSuggestion(null);
                  setFarConfirmed(false);
                }}
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary disabled:opacity-50"
              >
                <option value="">{t('location.selectDistrict')}</option>
                {districts.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              disabled={!canContinueStep1}
              onClick={() => {
                setStatus(null);
                setStep(2);
              }}
              className="h-12 w-full rounded-xl bg-brand px-4 text-base font-semibold text-background disabled:opacity-50"
            >
              {t('location.next')}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-primary">{t('location.step2Title')}</h4>
            {selectedDistrict && (
              <p className="text-xs text-tertiary">
                {selectedDistrict.name} · {province ? provinces.find((p) => p.code === province)?.name : ''}
              </p>
            )}

            <label className="block text-xs text-tertiary">
              {t('location.address')}
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t('location.addressPlaceholder')}
                maxLength={160}
                inputMode="text"
                autoComplete="street-address"
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary"
              />
            </label>

            <label className="block text-xs text-tertiary">
              {t('location.reference')}
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder={t('location.referencePlaceholder')}
                maxLength={120}
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary"
              />
            </label>

            <button
              type="button"
              onClick={() => void takeGpsLocation()}
              disabled={gpsBusy}
              className="h-12 w-full rounded-xl border border-border-strong px-4 text-base font-medium text-primary disabled:opacity-50"
            >
              {gpsBusy ? t('location.gpsLoading') : t('location.useGps')}
            </button>

            <button
              type="button"
              onClick={() => void locateOnMap()}
              disabled={!canContinueStep2 || geocodeBusy}
              className="h-12 w-full rounded-xl bg-brand px-4 text-base font-semibold text-background disabled:opacity-50"
            >
              {geocodeBusy ? t('location.locating') : t('location.locateOnMap')}
            </button>

            <button
              type="button"
              onClick={() => {
                setStatus(null);
                setSuggestion(null);
                setStep(1);
              }}
              className="h-11 text-sm text-tertiary underline-offset-2 hover:text-primary hover:underline"
            >
              {t('location.back')}
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-primary">{t('location.step3Title')}</h4>

            {/* Resumen: lo que se va a guardar, antes de confirmar. */}
            <div className="rounded-xl border border-border bg-surface-raised p-3">
              <h5 className="text-xs uppercase tracking-[2px] text-tertiary">
                {t('location.summaryTitle')}
              </h5>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-tertiary">{t('location.department')}</dt>
                  <dd className="text-right font-medium text-primary">{summary?.department ?? ''}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-tertiary">{t('location.province')}</dt>
                  <dd className="text-right font-medium text-primary">{summary?.province ?? ''}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-tertiary">{t('location.district')}</dt>
                  <dd className="text-right font-medium text-primary">{summary?.district ?? ''}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-tertiary">{t('location.address')}</dt>
                  <dd className="text-right font-medium text-primary">{summary?.address ?? ''}</dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() => {
                  setStatus(null);
                  setStep(1);
                }}
                className="mt-3 h-10 text-sm text-secondary underline underline-offset-2 hover:text-primary"
              >
                {t('location.summaryEdit')}
              </button>
            </div>

            <p className="text-xs text-tertiary">{t('location.mapHelp')}</p>

            <div ref={mapRef} tabIndex={-1}>
              <MapCanvas
                center={effectiveMarker ?? { latitude: -9.19, longitude: -75.0152 }}
                marker={effectiveMarker}
                onMarkerChange={(point) => {
                  setMarker(point);
                  // Ajuste manual: el origen deja de ser GPS/geocoder.
                  setSource('map_pin');
                  setFarConfirmed(false);
                }}
                label={t('location.mapLabel')}
                className="h-72 w-full overflow-hidden rounded-2xl border border-border"
              />
            </div>

            {pinVerdict.level === 'blocked' && (
              <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3">
                <p className="text-sm font-medium text-destructive">{t('location.pinTooFar')}</p>
                <p className="mt-1 text-xs text-secondary">{t('location.pinTooFarHelp')}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => mapRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                    className="h-11 flex-1 rounded-xl border border-border-strong px-3 text-sm font-medium text-primary"
                  >
                    {t('location.fixMarker')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus(null);
                      setStep(1);
                    }}
                    className="h-11 flex-1 rounded-xl border border-border-strong px-3 text-sm font-medium text-primary"
                  >
                    {t('location.changeDistrict')}
                  </button>
                </div>
              </div>
            )}

            {pinVerdict.level === 'review' && (
              <div className="rounded-xl border border-warning/50 bg-warning/10 p-3">
                <p className="text-sm text-warning">
                  {t('location.pinReview', { km: Math.round(pinVerdict.km) })}
                </p>
                <button
                  type="button"
                  onClick={() => setFarConfirmed(true)}
                  className="mt-3 h-11 w-full rounded-xl border border-warning/60 px-3 text-sm font-medium text-primary"
                >
                  {t('location.pinReviewConfirm')}
                </button>
              </div>
            )}

            {pinVerdict.level === 'ok' && farConfirmed && (
              <p className="text-xs text-secondary">{t('location.pinReviewConfirmed')}</p>
            )}

            {!hideSubmit && (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={saving || !value}
                className="h-12 w-full rounded-xl bg-brand px-4 text-base font-semibold text-background disabled:opacity-50"
              >
                {saving ? t('location.saving') : (submitLabel ?? t('location.summaryConfirm'))}
              </button>
            )}

            {hideSubmit && (
              <p className="text-sm text-secondary">{t('location.confirmHint')}</p>
            )}

            <button
              type="button"
              onClick={() => {
                setStatus(null);
                setStep(2);
              }}
              className="h-11 text-sm text-tertiary underline-offset-2 hover:text-primary hover:underline"
            >
              {t('location.back')}
            </button>
          </div>
        )}
      </div>

      {suggestion && (
        <div
          role="status"
          className="mt-4 rounded-xl border border-warning/50 bg-warning/10 p-3"
        >
          <p className="text-sm text-primary">
            {suggestion.source === 'gps'
              ? t('location.gpsOtherDistrict', { place: suggestion.label })
              : t('location.geocoderOtherDistrict', { place: suggestion.label })}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => chooseSuggestion('use')}
              className="h-11 flex-1 rounded-xl bg-brand px-3 text-sm font-semibold text-background"
            >
              {t('location.useThisLocation')}
            </button>
            <button
              type="button"
              onClick={() => chooseSuggestion('keep')}
              className="h-11 flex-1 rounded-xl border border-border-strong px-3 text-sm font-medium text-primary"
            >
              {t('location.keepMySelection')}
            </button>
          </div>
        </div>
      )}

      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 rounded-xl px-3 py-2 text-sm ${
            status.kind === 'error'
              ? 'bg-destructive/10 text-destructive'
              : status.kind === 'warn'
                ? 'bg-warning/10 text-warning'
                : 'bg-surface-raised text-secondary'
          }`}
        >
          {status.message}
        </p>
      )}
    </section>
  );
}
