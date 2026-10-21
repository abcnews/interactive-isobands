/**
 * @file
 * Entrypoint. Creates a non-module es5entry.js in your build.
 */
import { whenDOMReady } from '@abcnews/env-utils';
import { selectMounts } from '@abcnews/mount-utils';
import App from './App.svelte';
import { mount } from 'svelte';

whenDOMReady.then(async () => {
  const [appMountEl] = selectMounts('interactiveisobands');

  if (appMountEl) {
    mount(App, { target: appMountEl });
  }

  const [builderMountEl] = selectMounts('builder');

  if (builderMountEl) {
    const builderModule = await import('./components/Builder/Builder.svelte');
    mount(builderModule.default, {
      target: builderMountEl
    });
  }

  // __ADDITIONAL_MOUNTS__
});

export default App;
