/**
 * @file
 * Entrypoint. Creates a non-module es5entry.js in your build.
 */
import acto from '@abcnews/alternating-case-to-object';
import { whenDOMReady } from '@abcnews/env-utils';
import { getMountValue, selectMounts } from '@abcnews/mount-utils';
import App from './App.svelte';
import { mount } from 'svelte';

whenDOMReady.then(async () => {
  const [appMountEl] = selectMounts('interactiveisobands');

  if (appMountEl) {
    const appProps = acto(getMountValue(appMountEl));

    mount(App, {
      target: appMountEl,
      props: appProps
    });
  }

  const [builderMountEl] = selectMounts('builder');

if (builderMountEl) {
  const appProps = getMountValue(builderMountEl);
  const builderModule = await import('./components/Builder/Builder.svelte');
  mount(builderModule.default, {
    target: builderMountEl
  });
}

// __ADDITIONAL_MOUNTS__
});

export default App;
