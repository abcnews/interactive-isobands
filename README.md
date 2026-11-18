# interactive-isobands

A project generated from [aunty](https://github.com/abcnews/aunty)'s `Svelte` project template.

## Developing

Create a dev server: `npm run dev`.

## iframe

Configure with the URL hash, e.g. `#startOffset=1&days=6&hide=ATTRIBUTION`.

- `start`: first day, `YYYY-MM-DD`. Defaults to today (Sydney).
- `startOffset`: days after today to start, e.g. `1` for tomorrow. Ignored if `start` is set.
- `days`: number of days. Defaults to 6.
- `show`: `|`-separated list of `TITLE|LEGEND|DATES|ATTRIBUTION` to show; anything not listed is hidden.
- `hide`: the same list, to hide instead.
- `renderer`: `raster` for canvas maps. Defaults to vector isobands.
- `look`: raster only, `smooth` for a gradient.
- `min`, `max`: raster smooth only, gradient end temperatures.
- `file`: filename in each date's folder.

## Publishing (during Aunty Next development)

During Aunty next development, we don't have an `aunty release` command so you need to run Aunty Next from the development branch. E.g. `{aunty app source}` should be the `git+github://` url of the Aunty Next branch to ensure you have the latest code.

- `npm run build`
- `npx {aunty app source} release-check`
- `npm version patch` or equivalent
- `npx {aunty app source} release`
