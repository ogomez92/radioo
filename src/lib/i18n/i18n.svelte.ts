import { en, type Messages } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { it } from './messages/it';
import { pt } from './messages/pt';
import { de } from './messages/de';
import { ja } from './messages/ja';

export type LangCode = 'en' | 'es' | 'fr' | 'it' | 'pt' | 'de' | 'ja';

const catalogs: Record<LangCode, Messages> = { en, es, fr, it, pt, de, ja };

export const LANGUAGES: { value: LangCode; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ja', label: '日本語' },
];

class I18n {
  lang = $state<LangCode>('en');

  setLang(lang: LangCode): void {
    if (catalogs[lang]) this.lang = lang;
  }

  t(key: string, params?: Record<string, string | number>): string {
    // Reading this.lang makes template evaluations reactive.
    const catalog = catalogs[this.lang];
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
}

export const i18n = new I18n();
