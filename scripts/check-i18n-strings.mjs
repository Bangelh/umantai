#!/usr/bin/env node
/**
 * scripts/check-i18n-strings.mjs — auditoría local de la interfaz bilingüe.
 *
 * Dos comprobaciones, sin red ni servicios externos:
 *
 *   1. CLAVES: toda clave usada con `t('…')` / `translate('…', '…')` existe en
 *      `lib/i18n/dictionaries.ts` (es y en). Un typo se detecta acá, no en QA.
 *   2. STRINGS: textos JSX y atributos visibles (placeholder, aria-label, alt,
 *      title) que siguen escritos en español fuera del diccionario, más las
 *      propiedades de etiqueta con texto literal (`label: 'Carrito'`) en
 *      módulos compartidos, que no se traducen nunca.
 *
 * El alcance incluye `app/`, `components/`, `lib/` y `config/`: el P2 del footer
 * (etiquetas en español dentro de una página en inglés) vivía justamente en
 * `lib/navigation.ts`, fuera del alcance anterior.
 *
 * Uso:
 *   node scripts/check-i18n-strings.mjs           # informe; falla solo por claves
 *   node scripts/check-i18n-strings.mjs --strict  # falla también por strings
 *   node scripts/check-i18n-strings.mjs --json    # salida para CI
 *
 * Las excepciones conscientes viven en ALLOWED_FILES / ALLOWED_STRINGS, con el
 * motivo escrito al lado. No se usa una lista de líneas: cualquier reformateo
 * invalidaría la allowlist.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['app', 'components', 'lib', 'config'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', 'dist', 'coverage']);

const ARGS = new Set(process.argv.slice(2));
const STRICT = ARGS.has('--strict');
const JSON_OUT = ARGS.has('--json');

/**
 * Archivos legacy que todavía no se migraron. Cada entrada debe tener motivo y
 * un dueño claro en la documentación (THEME_I18N_HARDENING.md). No agregar
 * archivos nuevos acá: la salida es usar `useI18n()`.
 */
const ALLOWED_FILES = new Map([
  [
    'lib/i18n/dictionaries.ts',
    'Es el diccionario es/en: acá VIVE el texto traducible, no es deuda pendiente.',
  ],
  ['app/admin/page.tsx', 'Panel legacy de Platform Admin; se reescribe en la fase de paneles.'],
  ['app/admin/notes/page.tsx', 'Demo de notas Supabase, no forma parte del producto.'],
  ['app/debug/supabase/page.tsx', 'Diagnóstico interno, no indexado ni visible al público.'],
  ['app/debug/page.tsx', 'Diagnóstico interno de staging.'],
  [
    'app/legal/page.tsx',
    'Los documentos legales solo existen en español (borrador pendiente de validación del negocio). Traducir el índice mezclaría idiomas en la misma página.',
  ],
  [
    'app/legal/[slug]/page.tsx',
    'Contenido legal en español, con lang="es" explícito; se traduce cuando el negocio apruebe las versiones en inglés.',
  ],
  [
    'app/opengraph-image.tsx',
    'Imagen Open Graph generada en el servidor: texto fijo de marketing, no interfaz navegable.',
  ],
  [
    'app/admin/kiosco/components/DeviceKeyGate.tsx',
    'Terminal de kiosco operado por personal en tienda: interfaz de un solo idioma (es).',
  ],
  [
    'app/admin/kiosco/components/KioskPinPad.tsx',
    'Terminal de kiosco operado por personal en tienda: interfaz de un solo idioma (es).',
  ],
  [
    'app/admin/kiosco/components/PinEntryPanel.tsx',
    'Terminal de kiosco operado por personal en tienda: interfaz de un solo idioma (es).',
  ],
  [
    'app/admin/kiosco/components/PickupResultOverlay.tsx',
    'Terminal de kiosco operado por personal en tienda: interfaz de un solo idioma (es).',
  ],
  [
    'app/admin/kiosco/components/PreparationList.tsx',
    'Terminal de kiosco operado por personal en tienda: interfaz de un solo idioma (es).',
  ],
  [
    'app/admin/kiosco/components/ReadyOrdersList.tsx',
    'Terminal de kiosco operado por personal en tienda: interfaz de un solo idioma (es).',
  ],
  ['app/admin/kiosco/page.tsx', 'Terminal de kiosco operado por personal en tienda: es.'],
  [
    'lib/legal.ts',
    'Contenido de los documentos legales: solo existe en español hasta que el negocio apruebe las versiones en inglés (misma razón que app/legal/*).',
  ],
  [
    'lib/email.server.ts',
    'Correo transaccional de auth: el cuerpo se redacta en español y no depende del locale de quien navega.',
  ],
  [
    'lib/notifications.server.ts',
    'Avisos al comprador y al kiosco (correo y pantalla operativa): español, igual que app/admin/kiosco/*.',
  ],
]);

/**
 * Cadenas que no se traducen aunque parezcan español: nombres propios, siglas,
 * unidades y marcadores técnicos. Se comparan exactas (trim).
 */
const ALLOWED_STRINGS = new Set([
  'UMANTAI',
  'SKU',
  'PIN',
  'DNI',
  'WhatsApp',
  'Platform Admin',
  'San Juan de Lurigancho',
  'S/',
  'kg',
  'unit',
  'meter',
  'liter',
  'pack',
  'Admin',
  'Admin • Notes',
  'Notes',
  '—',
  '·',
  '•',
  '+',
  '−',
  '%',
  '↑',
  '↓',
]);

const SPANISH_WORDS = [
  'buscar', 'carrito', 'pedido', 'pedidos', 'tienda', 'tiendas', 'producto',
  'productos', 'precio', 'precios', 'guardar', 'cancelar', 'cerrar', 'enviar',
  'nombre', 'correo', 'contraseña', 'cuenta', 'inicio', 'agregar', 'quitar',
  'volver', 'cargando', 'disponible', 'disponibles', 'agotado', 'cantidad',
  'total', 'fecha', 'estado', 'acción', 'acciones', 'comprar', 'vender',
  'ingresa', 'selecciona', 'variante', 'variantes', 'inventario', 'umbral',
  'ajuste', 'historial', 'movimientos', 'planes', 'suscripción', 'facturación',
  'ventas', 'venta', 'stock', 'pago', 'pagos', 'entrega', 'retiro', 'dirección',
  'teléfono', 'mensaje', 'aceptar', 'acepto', 'términos', 'privacidad',
  'categoría', 'categorías', 'marca', 'descripción', 'unidad', 'motivo',
  'usuario', 'sesión', 'salir', 'entrar', 'crear', 'editar', 'archivar',
  'publicar', 'despublicar', 'suscribirse', 'código', 'descuento', 'período',
  'renovación', 'estadísticas', 'resumen', 'panel', 'negocio', 'negocios',
  'comercio', 'comercios', 'ubicación', 'radio', 'zona', 'distrito', 'ciudad',
  'todos', 'todas', 'sin', 'con', 'para', 'desde', 'hasta', 'ayer', 'hoy',
  'semana', 'mes', 'año', 'día', 'días', 'nuevo', 'nueva', 'busca', 'resultado',
  'resultados', 'listo', 'pendiente', 'cancelado', 'expirado', 'confirmado',
  'reembolsado', 'entregado', 'completado', 'preparación', 'revisar', 'volver',
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx') || entry.endsWith('.d.ts')) {
      continue;
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rel(file) {
  return relative(ROOT, file).split(sep).join('/');
}

function looksSpanish(text) {
  const value = text.trim();
  if (!value || ALLOWED_STRINGS.has(value)) return false;
  if (/^[\d\s.,:;!?%+\-−/()·•↑↓]+$/.test(value)) return false;
  // Solo puede ser una marca o un identificador: sin espacios ni minúsculas no
  // hay nada que traducir (SKU-123, UM-ABC).
  if (!/[a-záéíóúñ]/.test(value)) return false;
  if (/^[A-Z0-9_\-/.:]+$/.test(value)) return false;
  // Fragmentos de código capturados por la heurística `>texto<` (genéricos,
  // arrow functions, llamadas): no son texto renderizado.
  if (/[;=]|=>|useState|\bconst\b|\bfunction\b|\(\s*['"]|\.\w+\(/.test(value)) return false;

  const lower = value.toLowerCase();
  if (/[áéíóúñ¿¡]/.test(value)) return true;
  return SPANISH_WORDS.some((word) => new RegExp(`(^|\\W)${word}(\\W|$)`, 'u').test(lower));
}

/** Quita comentarios de línea y de bloque para no reportar documentación. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scanStrings(source) {
  const clean = stripComments(source);
  const findings = [];

  // Texto JSX puro entre > y <, sin expresiones.
  const textRe = />([^<>{}]+)</g;
  let match;
  while ((match = textRe.exec(clean))) {
    const value = match[1].replace(/\s+/g, ' ').trim();
    if (!looksSpanish(value)) continue;
    findings.push({ line: lineAt(clean, match.index), kind: 'text', value });
  }

  // Atributos que el usuario ve o escucha.
  const attrRe = /\b(placeholder|aria-label|aria-description|alt|title)\s*=\s*["']([^"']+)["']/g;
  while ((match = attrRe.exec(clean))) {
    const value = match[2].replace(/\s+/g, ' ').trim();
    if (!looksSpanish(value)) continue;
    findings.push({ line: lineAt(clean, match.index), kind: match[1], value });
  }

  // Propiedades de etiqueta con texto literal. Un módulo compartido
  // (`lib/navigation.ts`) que guarda `label: 'Carrito'` es texto de interfaz que
  // no se puede traducir: se escapa del chequeo de JSX y del de atributos.
  const labelRe = /^[ \t]*(label|ariaLabel|heading|helperText)[ \t]*:[ \t]*(["'])([^"'\n]+)\2[ \t]*,?[ \t]*$/gm;
  while ((match = labelRe.exec(clean))) {
    const value = match[3].replace(/\s+/g, ' ').trim();
    if (!looksSpanish(value)) continue;
    findings.push({ line: lineAt(clean, match.index), kind: `${match[1]}:`, value });
  }

  return findings;
}

function loadMessageKeys() {
  const file = join(ROOT, 'lib/i18n/dictionaries.ts');
  const source = readFileSync(file, 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

/** Claves usadas en el código con `t('…')` o `translate('xx', '…')`. */
function usedKeys() {
  const used = [];
  const dirs = [...SCAN_DIRS.map((dir) => join(ROOT, dir))];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        used.push({ key: match[1], file: rel(file), line: lineAt(source, match.index) });
      }
      for (const match of source.matchAll(/\btranslate\(\s*'(?:es|en)'\s*,\s*'([a-zA-Z0-9_.]+)'/g)) {
        used.push({ key: match[1], file: rel(file), line: lineAt(source, match.index) });
      }
    }
  }
  return used;
}

const keys = loadMessageKeys();
const used = usedKeys();
const missingKeys = used.filter((entry) => !keys.has(entry.key));

const hardcoded = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const name = rel(file);
    if (ALLOWED_FILES.has(name)) continue;
    const findings = scanStrings(readFileSync(file, 'utf8'));
    if (findings.length > 0) hardcoded.push({ file: name, findings });
  }
}

const result = {
  missingKeys,
  hardcoded,
  hardcodedCount: hardcoded.reduce((total, entry) => total + entry.findings.length, 0),
  allowedFiles: [...ALLOWED_FILES.keys()],
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (missingKeys.length > 0) {
    console.error(`✖ ${missingKeys.length} clave(s) usadas que no existen en el diccionario:`);
    for (const entry of missingKeys) {
      console.error(`  ${entry.file}:${entry.line}  ${entry.key}`);
    }
  } else {
    console.log(`✔ ${used.length} uso(s) de claves, todas presentes en es/en.`);
  }

  if (hardcoded.length > 0) {
    console.log(`\n⚠ ${result.hardcodedCount} string(s) de interfaz sin traducir en ${hardcoded.length} archivo(s):`);
    for (const entry of hardcoded) {
      console.log(`  ${entry.file}`);
      for (const finding of entry.findings) {
        console.log(`    ${finding.line}: [${finding.kind}] ${finding.value}`);
      }
    }
    console.log('\nMigrar a useI18n()/getTranslator(). Si es legacy consciente, documentarlo en ALLOWED_FILES.');
  } else {
    console.log('✔ No se encontraron strings de interfaz hardcodeados.');
  }

  console.log(`\nArchivos en allowlist: ${result.allowedFiles.length}`);
}

const failed = missingKeys.length > 0 || (STRICT && result.hardcodedCount > 0);
process.exit(failed ? 1 : 0);
