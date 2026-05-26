#!/usr/bin/env node
// Health check for the sources listed in `index.json`.
//
// Strategy
// - Read every entry in index.json
// - Load each provider's JS into a shared global scope, mimicking the
//   bootstrap that runs inside flutter_js at runtime
// - Run `search('', 1)` with a timeout
// - If search returns >= 1 result, follow up with `getDetail(firstResult.url)`
//   to verify the full happy path (not just the search endpoint)
// - Classify the outcome into one of: ok / slow / degraded / broken-parse
//   / broken-http / timeout / blocked-ci
// - Merge with the previous status.json so consecutiveFailures and
//   lastOkAt survive across runs
// - Write status.json. The workflow commits only if the file actually
//   changed.
//
// Runs locally and in GitHub Actions both — `node scripts/check-providers.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const TIMEOUT_MS = 12_000;       // hard cap per provider call
const SLOW_THRESHOLD_MS = 4_000; // total time (search + detail) above this -> "slow"

// ----------------------------------------------------------------------
// Shared JS host. Mirrors the bootstrap that flutter_js runs at startup;
// we eval it once into the module globals so every provider sees the
// same `__fetch`, `__callProvider`, and `__providers` map.
// ----------------------------------------------------------------------
const bootstrap = `
globalThis.__providers = globalThis.__providers || {};
globalThis.__fetch = async function(src, u, opts) {
  opts = opts || {};
  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': '*/*',
  }, opts.headers || {});
  const r = await fetch(u, { method: opts.method || 'GET', headers, body: opts.body });
  const text = await r.text();
  return {
    ok: r.ok, status: r.status, statusText: r.statusText,
    headers: Object.fromEntries(r.headers.entries()), url: r.url, body: text,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
globalThis.__console = function(src, level, args){
  const parts = [];
  for (let i=0;i<args.length;i++){ const a=args[i]; parts.push(typeof a==='string'?a:JSON.stringify(a)); }
  console.log('  ['+src+'/js '+level+']', parts.join(' '));
};
globalThis.htmlText = s => String(s||'')
  .replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
  .replace(/&#39;/g,"'").trim();
globalThis.absUrl = (h,b) => /^https?:\\/\\//i.test(h)
  ? h
  : (h.startsWith('//')
    ? 'https:'+h
    : (b
      ? (h.startsWith('/')
        ? (b.match(/^(https?:\\/\\/[^\\/]+)/)[1]+h)
        : (b.replace(/\\/$/,'')+'/'+h))
      : h));
globalThis.__callProvider = function(sourceId, method, argsJson){
  let args; try { args = JSON.parse(argsJson||'[]'); } catch(e){ return Promise.reject('bad args'); }
  const ns = globalThis.__providers[sourceId];
  if (!ns) return Promise.reject('not loaded: '+sourceId);
  const fn = ns[method];
  if (typeof fn !== 'function') return Promise.reject('missing method: '+method);
  try { return Promise.resolve(fn.apply(null, args)).then(v => JSON.stringify(v==null?null:v)); }
  catch(e){ return Promise.reject(String(e.message||e)); }
};
`;

// Wrap a provider's source so it runs in an IIFE with a per-source
// fetch/console shadow and registers its exported functions into
// __providers[id]. Uses defensive `typeof` guards because not every
// provider implements every method (novel sources skip getPages, etc.).
function wrap(sourceId, src) {
  return `
(function(){
  var __SOURCE_ID = ${JSON.stringify(sourceId)};
  var fetch = function(u,o){ return globalThis.__fetch(__SOURCE_ID, u, o); };
  var console = {
    log: function(){ globalThis.__console(__SOURCE_ID, 'log', arguments); },
    warn: function(){ globalThis.__console(__SOURCE_ID, 'warn', arguments); },
    error: function(){ globalThis.__console(__SOURCE_ID, 'error', arguments); }
  };
  ${src}
  var ns = {};
  try { ns.getInfo = getInfo; } catch(e) {}
  try { ns.search = search; } catch(e) {}
  try { ns.getDetail = getDetail; } catch(e) {}
  try { ns.getChapters = getChapters; } catch(e) {}
  try { ns.getPages = getPages; } catch(e) {}
  try { ns.getChapterContent = getChapterContent; } catch(e) {}
  globalThis.__providers[__SOURCE_ID] = ns;
})();
`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer));
}

// Map a thrown error into one of our status buckets. The string heuristics
// are intentionally lenient — the goal is "what kind of failure" not "which
// exact error", because providers throw whatever they feel like.
function classifyError(err) {
  const msg = String(err?.message || err || '');
  if (/timeout|timed out|aborted/i.test(msg)) {
    return { status: 'timeout', detail: msg };
  }
  if (/cloudflare|cf-ray|just a moment|enable cookies|captcha|attention required/i.test(msg)) {
    return { status: 'blocked-ci', detail: 'Cloudflare/bot detection' };
  }
  const httpMatch = msg.match(/HTTP\s*([45]\d\d)/i);
  if (httpMatch) {
    return { status: 'broken-http', detail: `HTTP ${httpMatch[1]}` };
  }
  if (/cannot read|undefined|null|TypeError|SyntaxError/i.test(msg)) {
    return { status: 'broken-parse', detail: msg };
  }
  return { status: 'broken-unknown', detail: msg };
}

async function checkSource(meta) {
  const startedAt = new Date().toISOString();
  const file = path.join(REPO_ROOT, meta.file);

  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      status: 'broken-parse',
      latencyMs: null,
      error: `read failed: ${e.message}`,
      checkedAt: startedAt,
    };
  }
  try {
    // Strict-mode eval is scope-isolated; the IIFE registers its exports
    // into the global __providers map, so subsequent __callProvider calls
    // work regardless of where this eval ran.
    eval(wrap(meta.id, src));
  } catch (e) {
    return {
      status: 'broken-parse',
      latencyMs: null,
      error: `load failed: ${e.message}`,
      checkedAt: startedAt,
    };
  }
  if (!globalThis.__providers[meta.id]) {
    return {
      status: 'broken-parse',
      latencyMs: null,
      error: 'provider did not register into __providers',
      checkedAt: startedAt,
    };
  }

  // Stage 1: search('', page=1). Empty query is the cheapest call every
  // provider implements; most sources return the catalog landing page.
  const searchStart = Date.now();
  let searchResults;
  try {
    const json = await withTimeout(
      globalThis.__callProvider(meta.id, 'search', '["", 1]'),
      TIMEOUT_MS,
      'search',
    );
    searchResults = JSON.parse(json);
  } catch (e) {
    const cls = classifyError(e);
    return {
      status: cls.status,
      latencyMs: Date.now() - searchStart,
      error: `search: ${cls.detail}`,
      checkedAt: startedAt,
    };
  }
  const searchMs = Date.now() - searchStart;

  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    return {
      status: 'degraded',
      latencyMs: searchMs,
      error: 'search returned no results',
      checkedAt: startedAt,
    };
  }

  const first = searchResults[0];
  if (!first || !first.url) {
    return {
      status: 'broken-parse',
      latencyMs: searchMs,
      error: 'search result missing url',
      checkedAt: startedAt,
    };
  }

  // Stage 2: getDetail on the first result. Catches parser drift that
  // search alone wouldn't reveal (e.g. detail page redesigned).
  const detailStart = Date.now();
  try {
    const json = await withTimeout(
      globalThis.__callProvider(meta.id, 'getDetail', JSON.stringify([first.url])),
      TIMEOUT_MS,
      'getDetail',
    );
    const detail = JSON.parse(json);
    if (!detail || !detail.title) {
      return {
        status: 'broken-parse',
        latencyMs: searchMs + (Date.now() - detailStart),
        error: 'detail missing title',
        checkedAt: startedAt,
      };
    }
  } catch (e) {
    const cls = classifyError(e);
    return {
      status: cls.status,
      latencyMs: searchMs + (Date.now() - detailStart),
      error: `detail: ${cls.detail}`,
      checkedAt: startedAt,
    };
  }
  const totalMs = searchMs + (Date.now() - detailStart);
  const status = totalMs > SLOW_THRESHOLD_MS ? 'slow' : 'ok';
  return { status, latencyMs: totalMs, error: null, checkedAt: startedAt };
}

async function main() {
  const indexPath = path.join(REPO_ROOT, 'index.json');
  const statusPath = path.join(REPO_ROOT, 'status.json');

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  let prior = {};
  if (fs.existsSync(statusPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      prior = parsed.sources || {};
    } catch {
      // Corrupted prior file — start over rather than crash.
      prior = {};
    }
  }

  // Set up the shared globals once before any provider loads.
  eval(bootstrap);

  const sources = {};
  for (const meta of index.sources) {
    console.log(`\n=== ${meta.id} (${meta.type}) ===`);
    const r = await checkSource(meta);
    const priorEntry = prior[meta.id] || {};
    const isOk = r.status === 'ok' || r.status === 'slow';
    sources[meta.id] = {
      status: r.status,
      latencyMs: r.latencyMs,
      lastOkAt: isOk ? r.checkedAt : (priorEntry.lastOkAt ?? null),
      lastCheckedAt: r.checkedAt,
      consecutiveFailures: isOk ? 0 : (priorEntry.consecutiveFailures ?? 0) + 1,
      ...(r.error ? { error: r.error } : {}),
    };
    const label = r.status + (r.latencyMs != null ? ` (${r.latencyMs}ms)` : '');
    console.log(`  -> ${label}${r.error ? `  ${r.error}` : ''}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    sources,
  };
  fs.writeFileSync(statusPath, JSON.stringify(out, null, 2) + '\n');

  const total = Object.keys(sources).length;
  const broken = Object.values(sources).filter(
    s => !/^(ok|slow)$/.test(s.status),
  ).length;
  console.log(`\n--- ${total - broken}/${total} healthy. status.json written. ---`);
}

main().catch((e) => {
  console.error('check-providers crashed:', e);
  process.exit(1);
});
