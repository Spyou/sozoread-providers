# sozoread-providers

JavaScript provider modules for the [Sozo Read](https://github.com/Spyou/Sozo-Read) Flutter app. Each `.js` file in this repo is a self-contained scraper for one site (a manga aggregator, a web-novel host, etc.) that the app can install at runtime — no app update needed.

## How users install a source

Inside the Sozo Read app: **Settings → Sources → +** then paste:

| Field | Value |
|---|---|
| Name | `weebcentral` (or whatever the source's stable id is — used in URLs and library entries) |
| JS raw URL | `https://raw.githubusercontent.com/Spyou/sozoread-providers/main/weebcentral.js` |

The app downloads the file, evaluates it in a sandboxed QuickJS runtime, and the source becomes selectable in Home / Search / etc.

## Provider contract

A provider is a plain `.js` file exposing five global functions. The Sozo Read host gives you a small API (`fetch`, `htmlText`, regex helpers) — you don't get a DOM, just strings.

```js
function getInfo() {
  return {
    name: 'My Source',      // Display name
    lang: 'en',
    baseUrl: 'https://...',
    logo: '<absolute logo URL>',
    type: 'manga',          // or 'novel'
    version: '1.0.0',
  };
}

async function search(query, page, opts) {
  // opts.category is a genre name when filtered (string, can be empty).
  return [
    { id, title, url, cover, sourceId: 'my-source', type: 'manga' },
    // ...
  ];
}

async function getDetail(url) {
  return {
    id, sourceId, title, cover, url,
    author, status, description, genres: [],
    type: 'manga',
    chapters: [
      { id, title, number, url, date },
      // newest-first for manga; oldest-first for novels
    ],
  };
}

async function getChapters(seriesUrl) {
  // Only needed if your detail response doesn't include chapters.
  // Otherwise just `return [];` and the app uses detail.chapters.
}

async function getPages(chapterUrl) {
  // For manga: list of image URLs in reading order.
  return [
    { url: 'https://cdn.example.com/p1.jpg', headers: { Referer: '...' } },
    // ...
  ];
}

async function getChapterContent(chapterUrl) {
  // Novel-only — returns the full chapter text/HTML.
  return { title, html, nextUrl, prevUrl };
}
```

## What the host environment gives you

| Function / global | What it does |
|---|---|
| `fetch(url, opts)` | Network fetch. Returns `{ status, body, headers }`. Honours `opts.headers`. |
| `htmlText(html)` | Decodes HTML entities + collapses whitespace. |
| `console.log(...)` | Logs to `flutter logs` prefixed with `[sourceId/js log]`. |
| Standard JS (ES5-ish via QuickJS) | No `fetch` polyfills needed for window globals. No DOM, no `XMLHttpRequest`. |

## Examples

The seven files in this repo are the providers Sozo Read ships out of the box. They're useful starting points:

| File | Site | Type |
|---|---|---|
| `weebcentral.js` | weebcentral.com | manga (htmx fragment endpoints) |
| `mangapill.js` | mangapill.com | manga |
| `mangakatana.js` | mangakatana.com | manga |
| `mangadex.js` | mangadex.org | manga (JSON API) |
| `mangakakalot.js` | mangakakalot.com | manga |
| `freewebnovel.js` | freewebnovel.com | novel |
| `novelbin.js` | novelbin.com | novel |

To add a new source: copy the closest match, rename, swap the URLs / regexes, push to your fork.

## Versioning

Bump the `version` string in `getInfo()` when you change the file. The app refreshes installed providers on Sources → tap the refresh icon → installed providers re-fetch from their original URL.

## License

These scrapers respect the source sites' robots.txt and rate limits. The code itself is MIT.
