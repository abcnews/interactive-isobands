import { writable, type Writable } from 'svelte/store';

/**
 * A writable store whose value is persisted to, and restored from, the URL hash
 * (e.g. `#preset=none&min=10&interval=2`).
 *
 * Avoiding read/write loops
 * -------------------------
 * 1. Writes use `history.replaceState`, which (unlike assigning `location.hash`) never fires
 *    `hashchange` and doesn't add a history entry per change.
 * 2. Both directions compare *canonical encodings* of the state rather than object identity:
 *      - store -> hash: skipped if the encoding equals the last one we saw.
 *      - hash -> store: skipped if the decoded hash encodes to what the store already holds.
 *    So even if a browser did echo our own write back as an event, it would be a no-op.
 * 3. Writes are debounced (sliders and number fields change rapidly, and Safari throws if
 *    replaceState is called more than ~100 times in 30s). A real `hashchange` cancels any
 *    pending write, so the user's navigation wins over a stale queued value.
 */

export type Codec<V> = {
  /** Returns undefined when the raw string isn't valid, so that key falls back to its default. */
  decode: (raw: string) => V | undefined;
  /** Returns undefined when the value can't be represented (e.g. an empty number field mid-edit); the key is then omitted. */
  encode: (value: V) => string | undefined;
};

export const numberCodec: Codec<number> = {
  decode: raw => {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  },
  encode: n => (typeof n === 'number' && Number.isFinite(n) ? String(n) : undefined)
};

export const booleanCodec: Codec<boolean> = {
  decode: raw => (raw === '1' ? true : raw === '0' ? false : undefined),
  encode: b => (b ? '1' : '0')
};

/** Only accepts one of the allowed values, so a hand-edited or stale URL can't put the app in an impossible state. */
export const enumCodec = <V extends string | number>(allowed: readonly V[]): Codec<V> => ({
  decode: raw => allowed.find(a => String(a) === raw),
  encode: v => String(v)
});

export type HashSchema<T> = { [K in keyof T]: Codec<T[K]> };

export type HashStore<T> = Writable<T> & {
  /** Keys that were present (and valid) in the URL when the store was created, i.e. explicitly stored rather than defaulted. */
  initialKeys: ReadonlySet<keyof T>;
};

export const createHashStore = <T extends Record<string, string | number | boolean>>(
  schema: HashSchema<T>,
  defaults: T,
  { debounceMs = 250 }: { debounceMs?: number } = {}
): HashStore<T> => {
  const keys = Object.keys(schema) as (keyof T & string)[];
  const hasWindow = typeof window !== 'undefined';

  /** Canonical encoding: fixed key order, defaults omitted. Two equal states always produce the same string. */
  const encode = (state: T): string => {
    const params = new URLSearchParams();
    for (const key of keys) {
      if (state[key] === defaults[key]) continue;
      const raw = schema[key].encode(state[key]);
      if (raw !== undefined) params.set(key, raw);
    }
    return params.toString();
  };

  const decode = (hash: string) => {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const state: Record<string, unknown> = { ...defaults };
    const found = new Set<keyof T>();
    for (const key of keys) {
      const raw = params.get(key);
      if (raw === null) continue;
      const value = schema[key].decode(raw);
      if (value === undefined) continue; // invalid: keep the default
      state[key] = value;
      found.add(key);
    }
    return { state: state as T, found };
  };

  const initial = decode(hasWindow ? window.location.hash : '');
  const store = writable<T>(initial.state);

  if (hasWindow) {
    /** Canonical encoding of the store's latest value. */
    let lastEncoded = encode(initial.state);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const writeHash = (encoded: string) => {
      const wanted = encoded ? `#${encoded}` : '';
      if (window.location.hash === wanted) return;
      try {
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}${wanted}`
        );
      } catch (e) {
        console.warn('[hashStore] could not update the URL hash', e);
      }
    };

    // store -> hash
    store.subscribe(state => {
      const encoded = encode(state);
      if (encoded === lastEncoded) return;
      lastEncoded = encoded;
      clearTimeout(timer);
      timer = setTimeout(() => writeHash(encoded), debounceMs);
    });

    // hash -> store (manual edits, back/forward, pasted links)
    window.addEventListener('hashchange', () => {
      const { state } = decode(window.location.hash);
      if (encode(state) === lastEncoded) return; // nothing new (e.g. an echo of our own write)
      clearTimeout(timer);
      store.set(state); // the subscriber above then re-canonicalises the hash if it needs it; that write is a no-op once equal
    });

    // Don't lose a change made in the last few hundred ms.
    window.addEventListener('pagehide', () => {
      clearTimeout(timer);
      writeHash(lastEncoded);
    });
  }

  return { ...store, initialKeys: initial.found };
};
