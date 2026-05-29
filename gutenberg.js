// Project Gutenberg provider — 75,000+ free public-domain books.
//
// Scrapes www.gutenberg.org directly. An earlier draft used the
// Gutendex JSON API (https://gutendex.com) but it consistently took
// ~8s per call, which exceeds Sozo's 10s per-source timeout. The
// official site is ~1s per call and gives clean structured HTML
// (microdata + predictable class names), so direct scraping is the
// better fit.
//
// Chapter handling: Gutenberg books ship as a single HTML file with
// chapter headings embedded. getDetail() downloads that HTML once,
// splits on the most-frequent <h1>/<h2>/<h3> heading level, and
// embeds chapter URLs of the form `<htmlUrl>#<chapter_index>`.
// getChapterContent re-fetches and slices. Books that produce <5
// splits fall back to a single "Full text" chapter so the book is
// still openable; the novel reader's infinite-scroll handles long
// chunks fine.
//
// Languages are user-configurable via the per-source settings sheet
// (multi-select). Defaults to English only.

var SOURCE_ID = 'gutenberg';
var SITE = 'https://www.gutenberg.org';
var REFERER = SITE + '/';
var GUTENBERG_LOGO =
  'https://www.gutenberg.org/gutenberg/pg-logo-129x80.png';
var PAGE_SIZE = 25;
var MIN_SPLIT_CHAPTERS = 5;

function getInfo() {
  return {
    name: 'Project Gutenberg',
    lang: 'en',
    baseUrl: SITE,
    logo: GUTENBERG_LOGO,
    type: 'novel',
    version: '1.0.0',
  };
}

function getSettings() {
  return [
    {
      key: 'languages',
      label: 'Languages',
      type: 'multiEnum',
      default: ['en'],
      options: [
        { value: 'en', label: 'English' },
        { value: 'fr', label: 'French' },
        { value: 'de', label: 'German' },
        { value: 'fi', label: 'Finnish' },
        { value: 'nl', label: 'Dutch' },
        { value: 'it', label: 'Italian' },
        { value: 'pt', label: 'Portuguese' },
        { value: 'es', label: 'Spanish' },
        { value: 'sv', label: 'Swedish' },
        { value: 'la', label: 'Latin' },
        { value: 'el', label: 'Greek' },
        { value: 'ru', label: 'Russian' },
        { value: 'ja', label: 'Japanese' },
        { value: 'zh', label: 'Chinese' },
      ],
    },
  ];
}

function _userLangs() {
  var s = (typeof __settings !== 'undefined' && __settings[SOURCE_ID]) || {};
  var langs = s.languages;
  if (!Array.isArray(langs) || langs.length === 0) return ['en'];
  return langs;
}

async function search(query, page, opts) {
  page = page || 1;
  opts = opts || {};
  var category = opts.category || '';
  // Map Sozo's home sections to gutenberg.org sort params. Gutenberg
  // books are static, so popular vs trending is the same.
  var sortOrder = '';
  if (category === 'popular' || category === 'trending' || category === '') {
    sortOrder = 'downloads';
  } else if (category === 'latest') {
    sortOrder = 'release_date';
  }

  var langs = _userLangs();
  var startIndex = (page - 1) * PAGE_SIZE + 1;
  // gutenberg.org accepts ONE lang param at a time. When the user
  // picks multiple languages we call once per language and merge —
  // PAGE_SIZE-ish results per language, capped. This is roughly the
  // same total count as the user expects per page.
  var perLang = Math.max(8, Math.ceil(PAGE_SIZE / langs.length));
  var allResults = [];
  var seen = {};

  for (var li = 0; li < langs.length; li++) {
    var url = SITE + '/ebooks/search/?start_index=' + startIndex;
    if (query) url += '&query=' + encodeURIComponent(query);
    if (langs[li]) url += '&lang=' + encodeURIComponent(langs[li]);
    if (sortOrder) url += '&sort_order=' + sortOrder;
    console.log('gutenberg search url:', url);
    var res = await fetch(url, { headers: { Referer: REFERER } });
    if (res.status !== 200) {
      console.log('gutenberg search HTTP', res.status);
      continue;
    }
    var entries = _parseSearchResults(res.body);
    for (var i = 0; i < entries.length && i < perLang; i++) {
      if (seen[entries[i].id]) continue;
      seen[entries[i].id] = true;
      allResults.push(entries[i]);
    }
    if (allResults.length >= PAGE_SIZE * 1.5) break;
  }
  console.log('gutenberg search count:', allResults.length);
  return allResults;
}

async function getDetail(url) {
  var id = _idFromUrl(url);
  console.log('gutenberg detail id:', id);
  var detailUrl = SITE + '/ebooks/' + id;
  var res = await fetch(detailUrl, { headers: { Referer: REFERER } });
  if (res.status !== 200) {
    throw new Error('detail HTTP ' + res.status);
  }
  var html = res.body;

  // Title: <td itemprop="headline">Title</td>
  var title = _extract(html, /itemprop="headline"[^>]*>([\s\S]*?)<\/td>/i);
  // Author: <a ... itemprop="creator">Name, Year-Year</a> (may have
  // multiple). We grab all matches and join.
  var authors = [];
  var authorRe = /itemprop="creator"[^>]*>([\s\S]*?)<\/a>/gi;
  var am;
  while ((am = authorRe.exec(html)) !== null) {
    var name = htmlText(am[1]).replace(/,\s*\d{4}-(\d{4})?\s*$/, '').trim();
    if (name) authors.push(name);
  }

  // Subjects: <td><a class="block" href="/ebooks/subject/...">Subject</a></td>
  var genres = [];
  var subjRe =
    /href="\/ebooks\/subject\/[^"]+"[^>]*>([\s\S]*?)<\/a>/gi;
  var sm;
  while ((sm = subjRe.exec(html)) !== null && genres.length < 8) {
    var g = htmlText(sm[1]).trim();
    if (g) genres.push(g);
  }

  // Cover: predictable URL pattern. Skip parsing the detail page for
  // it — the /cache/epub path is canonical and the medium size fits
  // the book card better than the small thumb.
  var cover = SITE + '/cache/epub/' + id + '/pg' + id + '.cover.medium.jpg';

  // Description: Gutenberg doesn't ship synopses. Compose a small
  // blurb from any download-count text on the page; otherwise a
  // generic one.
  var description = '';
  var dlMatch = html.match(/itemprop="interactionCount"[^>]*content="UserDownloads:(\d+)/);
  if (dlMatch) {
    description = Number(dlMatch[1]).toLocaleString() +
      ' downloads on Project Gutenberg.';
  }
  if (!description) {
    description = 'Public-domain book from Project Gutenberg.';
  }

  // HTML format URL — Gutenberg's convention. The -images variant is
  // present for most books; for the few without, the chapter download
  // will 404 and the JS host surfaces the error to the app.
  var htmlUrl = SITE + '/cache/epub/' + id + '/pg' + id + '-images.html';

  var chapters = await _buildChapters(htmlUrl);
  if (chapters.length === 0) {
    chapters = [{
      id: 'full',
      title: 'Full text',
      number: 1,
      url: htmlUrl + '#0',
      date: null,
    }];
  }

  console.log('gutenberg detail:', 'title=' + title,
    'chapters=' + chapters.length);

  return {
    id: String(id),
    sourceId: SOURCE_ID,
    title: title || ('Book #' + id),
    cover: cover,
    url: url,
    author: authors.join(', '),
    status: 'completed',
    description: description,
    genres: genres,
    type: 'novel',
    chapters: chapters,
  };
}

async function getChapters(seriesUrl) {
  // Chapters live in getDetail; this calls back through the same
  // path. Caching is handled by the app (BookDetailCache) so the
  // double fetch is bounded.
  var d = await getDetail(seriesUrl);
  return d.chapters || [];
}

async function getChapterContent(chapterUrl) {
  var parts = _splitUrl(chapterUrl);
  var res = await fetch(parts.htmlUrl, { headers: { Referer: REFERER } });
  if (res.status !== 200) {
    throw new Error('chapter HTTP ' + res.status);
  }
  var slices = _splitHtml(res.body);
  if (slices.length < MIN_SPLIT_CHAPTERS) {
    return {
      title: 'Full text',
      html: _stripFront(res.body),
      nextUrl: '',
      prevUrl: '',
    };
  }
  var idx = parts.index;
  if (idx < 0) idx = 0;
  if (idx >= slices.length) idx = slices.length - 1;
  var prevUrl = idx > 0 ? parts.htmlUrl + '#' + (idx - 1) : '';
  var nextUrl = idx < slices.length - 1
    ? parts.htmlUrl + '#' + (idx + 1)
    : '';
  return {
    title: slices[idx].title,
    html: slices[idx].html,
    nextUrl: nextUrl,
    prevUrl: prevUrl,
  };
}

// ---------------- helpers ----------------

function _idFromUrl(url) {
  var m = String(url).match(/\/ebooks\/(\d+)/);
  return m ? m[1] : String(url);
}

function _splitUrl(chapterUrl) {
  var hashIdx = String(chapterUrl).lastIndexOf('#');
  if (hashIdx < 0) return { htmlUrl: chapterUrl, index: 0 };
  return {
    htmlUrl: chapterUrl.substring(0, hashIdx),
    index: parseInt(chapterUrl.substring(hashIdx + 1), 10) || 0,
  };
}

function _extract(html, regex) {
  var m = regex.exec(html);
  return m ? htmlText(m[1]).trim() : '';
}

/**
 * Parse one search result HTML page into an array of book items.
 * Each result is a `<li class="booklink">` containing the link, a
 * cover thumb, a title span, and a subtitle (author) span.
 */
function _parseSearchResults(html) {
  var out = [];
  var liRe = /<li class="booklink">([\s\S]*?)<\/li>/gi;
  var m;
  while ((m = liRe.exec(html)) !== null) {
    var block = m[1];
    var idMatch = block.match(/href="\/ebooks\/(\d+)"/);
    if (!idMatch) continue;
    var id = idMatch[1];
    var title = _extract(block, /<span class="title">([\s\S]*?)<\/span>/);
    var author = _extract(block, /<span class="subtitle">([\s\S]*?)<\/span>/);
    out.push({
      id: id,
      sourceId: SOURCE_ID,
      title: title || ('Book #' + id),
      url: SITE + '/ebooks/' + id,
      cover: SITE + '/cache/epub/' + id + '/pg' + id + '.cover.medium.jpg',
      author: author,
      type: 'novel',
    });
  }
  return out;
}

async function _buildChapters(htmlUrl) {
  var res = await fetch(htmlUrl, { headers: { Referer: REFERER } });
  if (res.status !== 200) return [];
  var slices = _splitHtml(res.body);
  if (slices.length < MIN_SPLIT_CHAPTERS) return [];
  var chapters = [];
  for (var i = 0; i < slices.length; i++) {
    chapters.push({
      id: 'c' + i,
      title: slices[i].title,
      number: i + 1,
      url: htmlUrl + '#' + i,
      date: null,
    });
  }
  return chapters;
}

/**
 * Split a Gutenberg HTML book into chapter slices.
 *
 * Trims front matter before <body> and the Gutenberg license footer
 * after the END OF marker. Finds every <h1>/<h2>/<h3> heading, picks
 * the most-frequent level as the chapter boundary (some books use
 * <h1> for the book title and <h2> for chapters, others use <h1>
 * for parts and <h3> for chapters), and slices.
 */
function _splitHtml(html) {
  if (!html) return [];
  var bodyMatch = /<body[^>]*>/i.exec(html);
  if (bodyMatch) {
    html = html.substring(bodyMatch.index + bodyMatch[0].length);
  }
  var footerRe = /\*\*\*\s*END OF (THE |THIS )?PROJECT GUTENBERG/i;
  var footerMatch = footerRe.exec(html);
  if (footerMatch) html = html.substring(0, footerMatch.index);

  var headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  var headings = [];
  var m;
  while ((m = headingRe.exec(html)) !== null) {
    headings.push({
      start: m.index,
      level: parseInt(m[1], 10),
      title: htmlText(m[2]).trim(),
    });
  }
  if (headings.length === 0) return [];

  var counts = { 1: 0, 2: 0, 3: 0 };
  for (var i = 0; i < headings.length; i++) {
    counts[headings[i].level] += 1;
  }
  var chapterLevel = 1;
  var maxCount = counts[1];
  if (counts[2] > maxCount) { chapterLevel = 2; maxCount = counts[2]; }
  if (counts[3] > maxCount) { chapterLevel = 3; maxCount = counts[3]; }

  var boundaries = [];
  for (var j = 0; j < headings.length; j++) {
    if (headings[j].level === chapterLevel) boundaries.push(headings[j]);
  }
  if (boundaries.length === 0) return [];

  var slices = [];
  for (var k = 0; k < boundaries.length; k++) {
    var startIdx = boundaries[k].start;
    var endIdx = (k + 1 < boundaries.length)
      ? boundaries[k + 1].start
      : html.length;
    slices.push({
      title: boundaries[k].title || ('Chapter ' + (k + 1)),
      html: html.substring(startIdx, endIdx),
    });
  }
  return slices;
}

function _stripFront(html) {
  if (!html) return '';
  var bodyMatch = /<body[^>]*>/i.exec(html);
  if (bodyMatch) {
    html = html.substring(bodyMatch.index + bodyMatch[0].length);
  }
  var footerRe = /\*\*\*\s*END OF (THE |THIS )?PROJECT GUTENBERG/i;
  var footerMatch = footerRe.exec(html);
  if (footerMatch) html = html.substring(0, footerMatch.index);
  return html;
}
