<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { i18n, LANGUAGES, type LangCode } from '../i18n/i18n.svelte';
  import Combobox from './Combobox.svelte';
</script>

<section class="panel" aria-labelledby="settings-language-heading">
  <h2 id="settings-language-heading">{i18n.t('settings.language')}</h2>
  <div class="row gap-md" style="align-items: center">
    <Combobox
      options={LANGUAGES}
      value={store.language}
      label={i18n.t('combobox.selectLanguage')}
      onChange={(v) => {
        store.language = v as LangCode;
        i18n.setLang(store.language);
      }}
    />
  </div>
</section>

<section class="panel" aria-labelledby="settings-playback-heading">
  <h2 id="settings-playback-heading">{i18n.t('settings.playback')}</h2>

  <div class="col gap-sm">
    <label class="row gap-sm" style="cursor: pointer">
      <input
        type="checkbox"
        checked={store.muteSysWhileMusicPlaying}
        onchange={(e) => (store.muteSysWhileMusicPlaying = (e.target as HTMLInputElement).checked)}
        aria-describedby="mute-sys-desc"
      />
      <span>{i18n.t('settings.muteSysWhileMusicPlaying')}</span>
    </label>
    <p id="mute-sys-desc" class="text-sm text-muted" style="margin-left: 24px">
      {i18n.t('settings.muteSysWhileMusicPlayingDesc')}
    </p>
  </div>
</section>

<section class="panel" aria-labelledby="settings-listeners-heading">
  <h2 id="settings-listeners-heading">{i18n.t('settings.listenerCountHeading')}</h2>

  <div class="col gap-sm">
    <label for="listener-count-url">{i18n.t('settings.listenerCountUrl')}</label>
    <input
      id="listener-count-url"
      type="url"
      placeholder="http://host:port/mount"
      value={store.listenerCountUrl}
      oninput={(e) => (store.listenerCountUrl = (e.target as HTMLInputElement).value)}
      aria-describedby="listener-count-url-desc"
    />
    <p id="listener-count-url-desc" class="text-sm text-muted">
      {i18n.t('settings.listenerCountUrlDesc')}
    </p>
  </div>
</section>
