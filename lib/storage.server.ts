/**
 * lib/storage.server.ts — imágenes de tienda/producto/master.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DRIVERS
 *
 *  · `db` (default): el binario se guarda en `media_assets` (bytea) y se sirve
 *    por `/api/media/<object_key>`. Es el fallback seguro de staging: Railway
 *    tiene filesystem efímero y staging todavía no tiene credenciales R2.
 *  · `r2`: S3-compatible de Cloudflare R2. Se activa con `MEDIA_DRIVER=r2` y
 *    `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
 *    `R2_PUBLIC_BASE_URL` es opcional; sin ella la app sirve la imagen por el
 *    proxy `/api/media/<key>` (que lee R2 con credenciales de servidor).
 *
 *  SEGURIDAD
 *    · key generada por el servidor (UUID); el usuario nunca la elige.
 *    · MIME real por magic bytes, no por `Content-Type` del navegador.
 *    · JPEG/PNG/WebP; máximo 2 MB.
 *    · sin `../`, sin nombres originales, sin filesystem.
 *    · staging y producción usan credenciales/bucket distintos por entorno.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';

import { CatalogError } from './catalog';
import { requirePlatformSql, toIsoString } from './platform-db.server';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type MediaScope = 'store_logo' | 'store_banner' | 'product_image' | 'master_image';
export type MediaDriver = 'db' | 'r2';

export interface StoredMedia {
  id: string;
  key: string;
  url: string;
  mime: string;
  sizeBytes: number;
  scope: MediaScope;
  createdAt: string;
}

interface ImageFormat {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}

/** Detecta el formato por firma. No confía en el nombre ni en el header. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: 'image/webp', extension: 'webp' };
  }
  return null;
}

export function mediaDriver(): MediaDriver {
  return process.env.MEDIA_DRIVER === 'r2' ? 'r2' : 'db';
}

function r2Config(): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string | null;
} {
  const config = {
    accountId: process.env.R2_ACCOUNT_ID?.trim() ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '',
    bucket: process.env.R2_BUCKET?.trim() ?? '',
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null,
  };
  if (!config.accountId || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
    throw new CatalogError(
      'media_not_configured',
      'MEDIA_DRIVER=r2 requiere R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET.',
      503,
    );
  }
  return config;
}

function encodeKeyPath(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function mediaUrl(key: string): string {
  if (mediaDriver() === 'r2') {
    const base = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
    if (base) return `${base}/${encodeKeyPath(key)}`;
  }
  return `/api/media/${encodeKeyPath(key)}`;
}

export function isValidMediaKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9/_.-]{7,180}$/.test(key) && !key.includes('..') && !key.includes('//');
}

// =============================================================================
//  R2 / S3 — firma AWS SigV4 con Web Crypto (sin SDK)
// =============================================================================

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function r2Request(
  method: 'GET' | 'PUT',
  key: string,
  body?: Uint8Array,
  contentType = 'application/octet-stream',
): Promise<Response> {
  const config = r2Config();
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payload = body ?? new Uint8Array();
  const payloadHash = await sha256Hex(payload);

  const canonicalUri = `/${encodeURIComponent(config.bucket)}/${encodeKeyPath(key)}`;
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${config.secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, 'auto');
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = [...new Uint8Array(await hmacSha256(kSigning, stringToSign))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const response = await fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: {
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: method === 'PUT' ? (payload as unknown as BodyInit) : undefined,
  });

  if (!response.ok) {
    throw new CatalogError(
      'media_storage_failed',
      `R2 respondió ${response.status} al ${method} de la imagen.`,
      502,
    );
  }
  return response;
}

// =============================================================================
//  API PÚBLICA DEL ADAPTADOR
// =============================================================================

export interface PutImageInput {
  scope: MediaScope;
  file: File;
  userId: string | null;
  storeId?: string | null;
  storeProductId?: string | null;
  masterProductId?: string | null;
}

/**
 * Valida el archivo, lo guarda en el driver y devuelve la URL pública. El
 * llamador debe haber comprobado antes que el scope pertenece al usuario.
 */
export async function putImage(input: PutImageInput): Promise<StoredMedia> {
  const file = input.file;
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new CatalogError('media_missing', 'Falta el archivo de imagen.', 400);
  }
  if (file.size <= 0) {
    throw new CatalogError('media_empty', 'La imagen está vacía.', 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new CatalogError(
      'media_too_large',
      `La imagen supera el máximo de ${Math.round(MAX_IMAGE_BYTES / 1024)} KB.`,
      413,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectImageFormat(bytes);
  if (!format) {
    throw new CatalogError(
      'media_invalid_mime',
      'Formato no permitido. Usa JPG, PNG o WebP.',
      415,
    );
  }

  const owner =
    input.scope === 'master_image'
      ? input.masterProductId
      : input.scope === 'product_image'
        ? input.storeProductId
        : input.storeId;
  if (!owner) {
    throw new CatalogError('media_owner_required', 'La imagen necesita un dueño válido.', 400);
  }

  const driver = mediaDriver();
  const key = `${input.scope}/${owner}/${randomUUID()}.${format.extension}`;

  if (driver === 'r2') {
    await r2Request('PUT', key, bytes, format.mime);
  }

  const sql = requirePlatformSql();
  const rows = await sql`
    INSERT INTO media_assets (
      scope, object_key, mime, size_bytes, data, storage_driver,
      store_id, store_product_id, master_product_id, created_by_user_id
    ) VALUES (
      ${input.scope}, ${key}, ${format.mime}, ${bytes.byteLength},
      ${driver === 'db' ? Buffer.from(bytes) : null}, ${driver},
      ${input.storeId ?? null}::uuid, ${input.storeProductId ?? null}::uuid,
      ${input.masterProductId ?? null}::uuid, ${input.userId}
    )
    RETURNING id, object_key, mime, size_bytes, scope, created_at
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new CatalogError('media_store_failed', 'No se pudo guardar la imagen.', 500);

  return {
    id: String(row.id),
    key,
    url: mediaUrl(key),
    mime: String(row.mime),
    sizeBytes: Number(row.size_bytes),
    scope: String(row.scope) as MediaScope,
    createdAt: toIsoString(row.created_at),
  };
}

export async function getMedia(key: string): Promise<{
  mime: string;
  bytes: Uint8Array;
  createdAt: string;
} | null> {
  if (!isValidMediaKey(key)) return null;
  const sql = requirePlatformSql();
  const rows = await sql`
    SELECT mime, data, storage_driver, created_at
      FROM media_assets
     WHERE object_key = ${key} AND archived_at IS NULL
     LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  if (String(row.storage_driver) === 'r2') {
    const response = await r2Request('GET', key);
    return {
      mime: String(row.mime),
      bytes: new Uint8Array(await response.arrayBuffer()),
      createdAt: toIsoString(row.created_at),
    };
  }

  const data = row.data as Buffer | Uint8Array;
  return {
    mime: String(row.mime),
    bytes: data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer),
    createdAt: toIsoString(row.created_at),
  };
}

/** Archiva el asset (nunca borra el binario si pudo quedar referenciado). */
export async function archiveMedia(
  assetId: string,
  filter: { storeId?: string; masterProductId?: string },
): Promise<boolean> {
  const sql = requirePlatformSql();
  const rows = await sql`
    UPDATE media_assets
       SET archived_at = COALESCE(archived_at, NOW())
     WHERE id = ${assetId}::uuid
       AND (${filter.storeId ?? null}::uuid IS NULL OR store_id = ${filter.storeId ?? null}::uuid)
       AND (${filter.masterProductId ?? null}::uuid IS NULL OR master_product_id = ${filter.masterProductId ?? null}::uuid)
     RETURNING id
  `;
  return !!rows[0];
}
