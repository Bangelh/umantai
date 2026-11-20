/**
 * lib/search-suggest.ts — resaltado de sugerencias del buscador.
 *
 * Regla del buscador (reel 9): mientras escribes, la sugerencia muestra
 * resaltada la parte que ya escribiste. En español eso tiene que funcionar
 * igual con acentos y mayúsculas: quien escribe "camisa" debe ver marcado
 * "Camisá". Se compara sobre una copia sin diacríticos y en minúsculas, y se
 * devuelve el corte sobre el texto ORIGINAL, para no perder la tilde al pintar.
 */

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** Un carácter en minúscula y sin diacríticos (o el mismo si no aplica). */
function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Divide `text` en tres tramos: antes de la coincidencia, la coincidencia
 * (la primera) y el resto. Sin coincidencia devuelve un único tramo sin marcar.
 *
 * Si al plegar cambia el número de caracteres (ligaduras como "ﬁ" → "fi"),
 * no se resalta: es preferible no marcar a marcar el tramo equivocado.
 */
export function splitHighlight(text: string, query: string): HighlightPart[] {
  const rawQuery = query.trim();
  if (!text || !rawQuery) return [{ text, match: false }];

  const chars = Array.from(text);
  const foldedChars = chars.map(foldChar);
  if (foldedChars.join('').length !== chars.length) return [{ text, match: false }];

  const foldedText = foldedChars.join('');
  const foldedQuery = Array.from(rawQuery).map(foldChar).join('');
  if (!foldedQuery) return [{ text, match: false }];

  const start = foldedText.indexOf(foldedQuery);
  if (start < 0) return [{ text, match: false }];

  const end = start + foldedQuery.length;
  const parts: HighlightPart[] = [];
  const before = chars.slice(0, start).join('');
  if (before) parts.push({ text: before, match: false });
  parts.push({ text: chars.slice(start, end).join(''), match: true });
  const after = chars.slice(end).join('');
  if (after) parts.push({ text: after, match: false });
  return parts;
}
