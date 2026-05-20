// Sozo Read provider template — copy this file, rename it, fill in the
// site-specific bits, and push to your fork. The Sozo Read app installs
// the file by URL at runtime; no app rebuild needed.
//
// Five functions are required (search, getDetail, getChapters, getPages,
// getInfo). For novel providers, also implement getChapterContent.
//
// The host gives you a tiny API: `fetch(url, opts)` returns
// { status, body, headers }, and `htmlText(html)` decodes HTML entities.
// You DO NOT get a DOM — just strings. Use regex.

var SOURCE_ID = 'mysource';
var SITE = 'https://example.com';
var REFERER = SITE + '/';

// ----------------------------------------------------------------------
// Required: identifies the source to the app + chooses an icon.
// ----------------------------------------------------------------------
function getInfo() {
  return {
    name: 'My Source',
    lang: 'en',
    baseUrl: SITE,
    logo: SITE + '/favicon.png',
    type: 'manga',          // or 'novel'
    version: '1.0.0',
  };
}

// ----------------------------------------------------------------------
// Required: search the site by user query. `page` is 1-indexed.
// `opts.category` is an optional genre filter (string, may be empty).
// Return up to ~30 results per call; the app handles paging.
// ----------------------------------------------------------------------
async function search(query, page, opts) {
  page = page || 1;
  var url = SITE + '/search?q=' + encodeURIComponent(query) + '&page=' + page;
  var res = await fetch(url, { headers: { Referer: REFERER } });
  if (res.status !== 200) return [];

  var html = res.body;
  var out = [];
  // TODO: parse `html` with regex, push entries shaped like:
  //   { id, title, url, cover, sourceId: SOURCE_ID, type: 'manga' }
  return out;
}

// ----------------------------------------------------------------------
// Required: fetch a single series' metadata + chapter list.
// ----------------------------------------------------------------------
async function getDetail(url) {
  var res = await fetch(url, { headers: { Referer: REFERER } });
  if (res.status !== 200) {
    throw new Error('detail HTTP ' + res.status);
  }
  var html = res.body;
  // TODO: extract title, cover, author, status, description, genres
  // and chapter list.
  return {
    id: _idFromUrl(url),
    sourceId: SOURCE_ID,
    title: '',
    cover: '',
    url: url,
    author: '',
    status: 'unknown',
    description: '',
    genres: [],
    type: 'manga',
    chapters: [
      // { id, title, number, url, date }
      // Manga: newest first. Novel: oldest first.
    ],
  };
}

// ----------------------------------------------------------------------
// Required: returns chapter list for a series. Most sources can return
// chapters inside getDetail() instead — in which case this can return [].
// ----------------------------------------------------------------------
async function getChapters(seriesUrl) {
  return [];
}

// ----------------------------------------------------------------------
// Required (manga only): returns the page image URLs for one chapter.
// ----------------------------------------------------------------------
async function getPages(chapterUrl) {
  var res = await fetch(chapterUrl, { headers: { Referer: REFERER } });
  if (res.status !== 200) return [];
  var html = res.body;
  var out = [];
  // TODO: extract image URLs in reading order.
  //   out.push({ url: 'https://...', headers: { Referer: REFERER } });
  return out;
}

// ----------------------------------------------------------------------
// Required (novel only): returns the full chapter content.
// Remove if your source is manga.
// ----------------------------------------------------------------------
async function getChapterContent(chapterUrl) {
  var res = await fetch(chapterUrl, { headers: { Referer: REFERER } });
  return {
    title: '',
    html: '',         // chapter body as HTML (preferred) or plain text
    nextUrl: '',
    prevUrl: '',
  };
}

// ----------------------------------------------------------------------
// Helpers — keep these small and local. The host provides htmlText() for
// HTML-entity decoding; you typically also want a couple of regex utils.
// ----------------------------------------------------------------------
function _idFromUrl(url) {
  var m = String(url).match(/\/series\/([^\/?#]+)/);
  return m ? m[1] : url;
}

function _allMatches(html, regex) {
  var out = [];
  var m;
  regex.lastIndex = 0;
  while ((m = regex.exec(html)) !== null) {
    out.push(m);
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return out;
}
