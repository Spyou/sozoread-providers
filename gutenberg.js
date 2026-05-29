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
    version: '1.0.2',
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
    // Single-chapter fallback. NovelContent.text is plain text, not
    // HTML — the reader renders it verbatim, so we flatten the HTML
    // into paragraph-joined text the same way NovelBin / FreeWebNovel
    // do.
    return {
      title: 'Full text',
      text: _toText(_stripBoilerplate(res.body)),
      nextUrl: '',
    };
  }
  var idx = parts.index;
  if (idx < 0) idx = 0;
  if (idx >= slices.length) idx = slices.length - 1;
  var nextUrl = idx < slices.length - 1
    ? parts.htmlUrl + '#' + (idx + 1)
    : '';
  return {
    title: slices[idx].title,
    text: _toText(slices[idx].html),
    nextUrl: nextUrl,
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
  html = _stripBoilerplate(html);

  // Preferred path: many Gutenberg books wrap real chapters in
  // <div class="chapter">...</div> containers, which excludes
  // title-page headings, the Table of Contents, "by Author", etc.
  // When present this is much more reliable than guessing from
  // heading frequency.
  var divChapters = _splitByChapterDiv(html);
  if (divChapters.length >= MIN_SPLIT_CHAPTERS) return divChapters;

  var headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  var headings = [];
  var m;
  while ((m = headingRe.exec(html)) !== null) {
    headings.push({
      start: m.index,
      level: parseInt(m[1], 10),
      // Collapse the chapter title to one line. Gutenberg books often
      // split chapter titles across <br> tags ("CHAPTER I.<br>Down
      // the Rabbit-Hole"), which leaves a newline + indentation
      // mid-string after html stripping. Single-space-collapsing
      // makes that read like a sentence.
      title: htmlText(m[2]).replace(/\s+/g, ' ').trim(),
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

/**
 * Convert a chapter's HTML into reader-ready plain text.
 *
 * NovelContent.text is rendered verbatim by the novel reader — no HTML
 * parsing on the app side — so this method does the flattening:
 *
 *   1. drop <script>/<style> blocks (Gutenberg HTML has style blocks
 *      embedded in <head>; chapter slices shouldn't, but be defensive)
 *   2. swap <br> for a real newline so poetry-style line breaks survive
 *   3. walk block-level elements (p / h1-h6 / blockquote / li) in order
 *      and use htmlText() to strip remaining tags + decode entities
 *   4. normalize horizontal whitespace per line, preserve newlines,
 *      cap consecutive blank lines at one
 *   5. join paragraphs with a blank line so the reader's auto-paragraph
 *      spacing kicks in
 *
 * Falls back to a flat tag-strip when no block elements are present.
 */
function _toText(htmlSlice) {
  if (!htmlSlice) return '';
  var s = String(htmlSlice)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  var blockRe = /<(p|h[1-6]|blockquote|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  var paragraphs = [];
  var m;
  while ((m = blockRe.exec(s)) !== null) {
    var t = htmlText(m[2]);
    if (!t) continue;
    var lines = t.split('\n');
    var cleanedLines = [];
    for (var i = 0; i < lines.length; i++) {
      cleanedLines.push(lines[i].replace(/[ \t]+/g, ' ').trim());
    }
    var clean = cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (clean) paragraphs.push(clean);
  }
  if (paragraphs.length === 0) {
    return htmlText(s);
  }
  return paragraphs.join('\n\n');
}

/**
 * Find `<div class="chapter">...</div>` blocks in modern Gutenberg
 * HTML. Each block is one real chapter; the first heading inside is
 * the title.
 *
 * Returns [] if there are zero (or one — not enough to be a real
 * chapterised book) chapter divs; the caller falls back to
 * heading-frequency parsing in that case.
 *
 * Implementation note: matches the OPEN tag, then walks forward
 * counting nested <div>s to find the matching close. Naive regex
 * `<div ... class="chapter">...</div>` would stop at the first
 * inner `</div>`, which is wrong because Gutenberg chapter divs
 * contain inner divs (illustrations, blockquotes wrapped as div).
 */
function _splitByChapterDiv(html) {
  var chunks = [];
  var openRe = /<div[^>]*\bclass="chapter"[^>]*>/gi;
  var m;
  while ((m = openRe.exec(html)) !== null) {
    var startIdx = m.index;
    var bodyStart = m.index + m[0].length;
    // Walk forward counting <div> nesting to find the matching close.
    var depth = 1;
    var i = bodyStart;
    var divTagRe = /<\/?div[\s>]/gi;
    divTagRe.lastIndex = i;
    var t;
    while ((t = divTagRe.exec(html)) !== null) {
      if (t[0][1] === '/') depth -= 1;
      else depth += 1;
      if (depth === 0) {
        i = t.index + t[0].length;
        break;
      }
    }
    var endIdx = i;
    var blockHtml = html.substring(startIdx, endIdx);
    var titleMatch = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(blockHtml);
    var title = titleMatch
      ? htmlText(titleMatch[1]).replace(/\s+/g, ' ').trim()
      : '';
    chunks.push({
      title: title || ('Chapter ' + (chunks.length + 1)),
      html: blockHtml,
    });
  }
  return chunks;
}

/**
 * Strip Gutenberg's title-page + license boilerplate so chapter
 * detection and the single-chapter fallback don't pick up the eBook
 * frontmatter, the Table of Contents heading, or the license text.
 *
 * Modern Gutenberg HTML wraps these in dedicated <section> blocks
 * (`id="pg-header"` and `id="pg-footer"`). Older HTML uses an
 * `*** END OF THE PROJECT GUTENBERG ***` text marker. We handle both.
 */
function _stripBoilerplate(html) {
  if (!html) return '';
  var bodyMatch = /<body[^>]*>/i.exec(html);
  if (bodyMatch) {
    html = html.substring(bodyMatch.index + bodyMatch[0].length);
  }
  // Modern Gutenberg: explicit boilerplate sections.
  html = html.replace(
    /<section[^>]*id="pg-header"[^>]*>[\s\S]*?<\/section>/i,
    '',
  );
  html = html.replace(
    /<section[^>]*id="pg-footer"[^>]*>[\s\S]*$/i,
    '',
  );
  // Legacy Gutenberg: plain-text end marker.
  var footerRe = /\*\*\*\s*END OF (THE |THIS )?PROJECT GUTENBERG/i;
  var footerMatch = footerRe.exec(html);
  if (footerMatch) html = html.substring(0, footerMatch.index);
  return html;
}
