import { describe, it, expect } from 'vitest';
import { en, type Messages } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { it as itCatalog } from './messages/it';
import { pt } from './messages/pt';
import { de } from './messages/de';
import { ja } from './messages/ja';

// NOTE: we intentionally don't import the i18n singleton from i18n.svelte.ts here.
// That file uses `$state` runes, and importing it into a vitest-env test file
// trips a module-time error. We verify catalog integrity directly and
// re-implement the tiny `t()` resolver to cover it in isolation.

const catalogs = { en, es, fr, it: itCatalog, pt, de, ja } as const;

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') keys.push(...collectKeys(v, path));
    else keys.push(path);
  }
  return keys.sort();
}

function translate(catalog: Messages, key: string, params?: Record<string, string | number>): string {
  // Mirrors the resolver in i18n.svelte.ts.
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v: any = catalog;
  for (const p of parts) v = v?.[p];
  if (typeof v !== 'string') return key;
  if (params) {
    return v.replace(/\{(\w+)\}/g, (_: string, k: string) => {
      const val = params[k];
      return val === undefined ? `{${k}}` : String(val);
    });
  }
  return v;
}

describe('i18n catalog integrity', () => {
  const enKeys = collectKeys(en);

  it('English catalog has keys (sanity check)', () => {
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it.each(['es', 'fr', 'it', 'pt', 'de', 'ja'] as const)(
    '%s catalog has exactly the same keys as en',
    (code) => {
      const keys = collectKeys(catalogs[code]);
      expect(keys).toEqual(enKeys);
    },
  );

  it.each(Object.keys(catalogs))(
    '%s catalog has non-empty strings everywhere',
    (code) => {
      for (const key of collectKeys(catalogs[code as keyof typeof catalogs])) {
        const val = key.split('.').reduce<unknown>(
          (a, k) => (a as Record<string, unknown>)?.[k],
          catalogs[code as keyof typeof catalogs],
        );
        expect(typeof val).toBe('string');
        expect((val as string).length).toBeGreaterThan(0);
      }
    },
  );
});

describe('translate() resolver', () => {
  it('returns the translated string for a nested key', () => {
    expect(translate(en, 'app.title')).toBe('Radioo');
    expect(translate(en, 'sources.microphone')).toBe('Microphone');
  });

  it('interpolates {param} placeholders', () => {
    expect(translate(en, 'mixer.manualDuckHint', { key: 'Ctrl+Shift+D' }))
      .toContain('Ctrl+Shift+D');
    expect(translate(en, 'transport.listeners', { count: 7 })).toBe('Listeners: 7');
  });

  it('leaves unresolved placeholders with their braces intact', () => {
    expect(translate(en, 'transport.listeners')).toBe('Listeners: {count}');
  });

  it('falls back to returning the key itself on a miss', () => {
    expect(translate(en, 'totally.nonexistent.key')).toBe('totally.nonexistent.key');
  });

  it('switches correctly when given a different catalog', () => {
    expect(translate(es, 'app.live')).toBe('EN VIVO');
    expect(translate(fr, 'app.live')).toBe('EN DIRECT');
  });

  it('resolves the syscap keys we added for per-process capture', () => {
    expect(translate(en, 'sources.syscapModeAll')).toMatch(/capture/i);
    expect(translate(en, 'sources.syscapModeFiltered')).toMatch(/audio/i);
    expect(translate(en, 'sources.syscapModeInclude')).toMatch(/only/i);
    expect(translate(en, 'sources.syscapModeExclude')).toMatch(/except/i);
    expect(translate(en, 'announce.screenReaderAdded', { mode: 'exclude' }))
      .toContain('exclude');
  });

  it('stringifies numeric params', () => {
    expect(translate(en, 'announce.musicVolume', { percent: 42 }))
      .toBe('Music volume 42%');
  });
});
