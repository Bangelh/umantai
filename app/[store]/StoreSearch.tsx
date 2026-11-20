'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';

import { useI18n } from '@/components/i18n/I18nProvider';
import { normalizeSearchText } from '@/lib/catalog';
import { splitHighlight } from '@/lib/search-suggest';

const DEBOUNCE_MS = 300;

export interface StoreSuggestion {
  name: string;
  category: string | null;
}

interface Props {
  storeSlug: string;
  storeName: string;
  initialQuery: string;
  category: string;
  /** Nombres del catálogo de ESTA tienda, para sugerir sin pedir nada al servidor. */
  suggestions: StoreSuggestion[];
}

/**
 * Buscador de la vitrina.
 *
 * Antes solo funcionaba al enviar el formulario: no había botón para borrar, el
 * foco no se notaba y no sugería nada. Ahora escribe, espera 300 ms y navega una
 * sola vez (debounce) con la URL de resultados; las sugerencias se filtran en el
 * navegador sobre el catálogo de la tienda, así que no hay una petición por
 * tecla. Compara sin acentos: "camisa" encuentra "Camisá" y lo resalta.
 */
export function StoreSearch({ storeSlug, storeName, initialQuery, category, suggestions }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const lastPushed = useRef(initialQuery);

  const buildUrl = (query: string) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (category) params.set('category', category);
    const suffix = params.toString();
    return `/${storeSlug}${suffix ? `?${suffix}` : ''}`;
  };

  // Debounce: al dejar de escribir se navega una sola vez. Si el valor vuelve al
  // que ya está en la URL, no se hace nada (evita un render por cada borrado).
  useEffect(() => {
    if (q === lastPushed.current) return;
    const timer = window.setTimeout(() => {
      lastPushed.current = q;
      router.replace(buildUrl(q), { scroll: false });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // buildUrl se reconstruye con estos mismos valores; declararlos es suficiente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, router, storeSlug]);

  const matches = useMemo(() => {
    const raw = q.trim();
    if (raw.length < 2) return [];
    const needle = normalizeSearchText(raw);
    const items: StoreSuggestion[] = [];
    const seen = new Set<string>();
    for (const item of suggestions) {
      if (items.length >= 6) break;
      const key = item.name.toLocaleLowerCase('es');
      if (!item.name || seen.has(key)) continue;
      if (!normalizeSearchText(item.name).includes(needle)) continue;
      seen.add(key);
      items.push(item);
    }
    return items;
  }, [q, suggestions]);

  const showSuggestions = open && matches.length > 0;
  const hasFilter = Boolean(q.trim() || category);

  const choose = (name: string) => {
    setQ(name);
    setOpen(false);
    setActive(-1);
    lastPushed.current = name;
    router.replace(buildUrl(name), { scroll: false });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (current + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current <= 0 ? matches.length - 1 : current - 1));
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(matches[active].name);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <form
      action={`/${storeSlug}`}
      method="get"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        lastPushed.current = q;
        setOpen(false);
        router.replace(buildUrl(q), { scroll: false });
      }}
      className="flex gap-2"
    >
      <label htmlFor="store-search" className="sr-only">
        {t('store.searchLabel', { store: storeName })}
      </label>
      {category && <input type="hidden" name="category" value={category} />}
      <div
        className="relative min-w-0 flex-1"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOpen(false);
            setActive(-1);
          }
        }}
      >
        <input
          id="store-search"
          type="text"
          name="q"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('store.searchPlaceholder', { store: storeName })}
          maxLength={80}
          autoComplete="off"
          enterKeyHint="search"
          spellCheck={false}
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls="store-search-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `store-suggestion-${active}` : undefined}
          className="h-12 w-full rounded-xl border border-border-strong bg-surface px-3 pr-11 text-body focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
        {q && (
          <button
            type="button"
            onClick={() => {
              setQ('');
              setActive(-1);
              document.getElementById('store-search')?.focus();
            }}
            aria-label={t('search.clearInput')}
            className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-surface-raised hover:text-primary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
        {showSuggestions && (
          <ul
            id="store-search-suggestions"
            role="listbox"
            aria-label={t('search.suggestions')}
            className="absolute inset-x-0 top-[calc(100%+0.4rem)] z-40 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
          >
            {matches.map((item, index) => (
              <li key={`${item.name}:${index}`}>
                <button
                  type="button"
                  role="option"
                  id={`store-suggestion-${index}`}
                  aria-selected={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item.name)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                    index === active ? 'bg-surface-raised' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="min-w-0 truncate text-primary">
                    {splitHighlight(item.name, q).map((part, partIndex) =>
                      part.match ? (
                        <span key={partIndex} className="font-semibold text-brand">
                          {part.text}
                        </span>
                      ) : (
                        <span key={partIndex}>{part.text}</span>
                      ),
                    )}
                  </span>
                  {item.category && (
                    <span className="shrink-0 truncate text-xs text-tertiary">{item.category}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="submit"
        className="h-12 shrink-0 rounded-xl bg-brand px-4 text-base font-semibold text-background transition-opacity hover:opacity-90"
      >
        {t('store.search')}
      </button>
      {hasFilter && (
        <Link
          href={`/${storeSlug}`}
          className="inline-flex h-12 shrink-0 items-center rounded-xl px-2 text-sm text-tertiary hover:text-primary"
        >
          {t('store.clear')}
        </Link>
      )}
      <span className="sr-only" aria-live="polite">
        <Search aria-hidden="true" />
      </span>
    </form>
  );
}
