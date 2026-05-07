import { supabase } from './supabase.js';
import * as cheerio from 'cheerio';
import {
  hasOpenAiCredentials,
  isAiPipelineEnabled,
  rewriteAndAuditArticle,
  selectBestArticles,
} from './ai.js';

const timeoutMs = Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 15000);
const maxPerFeed = Number(process.env.NEWS_MAX_PER_FEED ?? 6);
const maxAgeDays = 0;
const MAX_AI_ARTICLES_PER_RUN = 6;
const DEFAULT_EDITORIAL_REVIEWER = process.env.NEWS_DEFAULT_REVIEWER?.trim() || 'Equipo Editorial DolarPeruHoy';

// Límites de concurrencia
const SCRAPE_CONCURRENCY = Number(process.env.NEWS_SCRAPE_CONCURRENCY ?? 3);
const FEED_CONCURRENCY = Number(process.env.NEWS_FEED_CONCURRENCY ?? 4);
const AI_CONCURRENCY = Number(process.env.NEWS_AI_CONCURRENCY ?? 3);

// Google Ads compliance: detectar y rechazar clickbait
const CLICKBAIT_PATTERNS = [
  /\b(increíble|impactante|shock|no vas a creer|revelado|filtrado)\b/i,
  /(\?{2,}|!{3,})/,
  /\b(te sorprenderá|lo que nadie dice)\b/i,
];

function isClickbait(text) {
  return CLICKBAIT_PATTERNS.some((pattern) => pattern.test(String(text ?? '')));
}

const fullScrapeEnabled = !['0', 'false', 'no', 'off'].includes(
  String(process.env.NEWS_FULL_SCRAPE_ENABLED ?? 'true').trim().toLowerCase()
);

const TRACKING_QUERY_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'fbclid', 'gclid', 'igshid',
]);

// ---------------------------------------------------------------------------
// pLimit: ejecuta tareas async en paralelo con límite de concurrencia
// ---------------------------------------------------------------------------
async function pLimit(tasks, limit) {
  const results = [];
  const queue = [...tasks];
  const executing = new Set();

  async function runNext() {
    if (queue.length === 0) return;
    const task = queue.shift();
    const p = Promise.resolve()
      .then(() => task())
      .catch((err) => ({ __pLimitError: true, err }))
      .finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);
    if (executing.size < limit) runNext();
    await p;
    runNext();
  }

  const starters = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(starters);
  await Promise.allSettled(results);
  return results;
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------
const BASE_FEEDS = [
  { source: 'El Comercio', url: 'https://elcomercio.pe/arc/outboundfeeds/rss/category/economia/?outputType=xml' },
  { source: 'El Comercio', url: 'https://elcomercio.pe/arc/outboundfeeds/rss/category/mundo/?outputType=xml' },
  { source: 'El Comercio', url: 'https://elcomercio.pe/arc/outboundfeeds/rss/category/tecnologia/?outputType=xml' },
  { source: 'Gestion',     url: 'https://gestion.pe/arc/outboundfeeds/rss/category/economia/?outputType=xml' },
  { source: 'Gestion',     url: 'https://gestion.pe/arc/outboundfeeds/rss/category/mercados/?outputType=xml' },
  { source: 'Andina',      url: 'https://andina.pe/agencia/rss.aspx' },
  { source: 'RPP',         url: 'https://rpp.pe/rss' },
  { source: 'La Republica', url: 'https://larepublica.pe/rss/economia.xml' },
];

function parseExtraFeedsFromEnv() {
  const raw = String(process.env.NEWS_EXTRA_FEEDS ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({ source: sanitizeText(item?.source), url: String(item?.url ?? '').trim() }))
      .filter((item) => item.source && /^https?:\/\//i.test(item.url));
  } catch { return []; }
}

function mergeFeeds(baseFeeds, extraFeeds) {
  const merged = [];
  const seen = new Set();
  for (const feed of [...baseFeeds, ...extraFeeds]) {
    if (!feed?.source || !feed?.url) continue;
    const key = `${feed.source.toLowerCase()}|${feed.url.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(feed);
  }
  return merged;
}

const FEEDS = mergeFeeds(BASE_FEEDS, parseExtraFeedsFromEnv());

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  'finanzas-personales': [
    'ahorro', 'credito', 'crédito', 'tarjeta', 'hipoteca', 'sueldo', 'presupuesto',
    'inversion', 'inversión', 'afp', 'cts', 'gratificacion', 'gratificación', 'deuda',
  ],
  educacion: ['colegio', 'universidad', 'estudiante', 'docente', 'beca', 'sunedu', 'escolar', 'examen', 'maestro'],
  comparativas: ['comparativa', 'comparar', 'versus', 'vs', 'ranking', 'mejor', 'peor', 'diferencia', 'conviene'],
  analisis: ['analisis', 'análisis', 'opinion', 'opinión', 'editorial', 'columna', 'perspectiva', 'claves'],
  guias: ['guia', 'guía', 'como', 'cómo', 'paso a paso', 'requisitos', 'tramite', 'trámite', 'tutorial'],
  economia: ['economia', 'economía', 'inflacion', 'inflación', 'bcr', 'dolar', 'dólar', 'tipo de cambio', 'mercado', 'pbi', 'empleo'],
};

const STOPWORDS = new Set([
  'a', 'al', 'algo', 'ante', 'con', 'contra', 'como', 'cual', 'de', 'del', 'desde',
  'donde', 'dos', 'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'es', 'esa',
  'ese', 'eso', 'esta', 'este', 'esto', 'fue', 'ha', 'hay', 'la', 'las', 'lo', 'los',
  'mas', 'me', 'mi', 'mis', 'muy', 'no', 'nos', 'o', 'para', 'pero', 'por', 'que',
  'se', 'si', 'sin', 'sobre', 'su', 'sus', 'te', 'tu', 'un', 'una', 'uno', 'y',
]);

const FREE_IMAGE_CATALOG = {
  economia: [
    'https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/730547/pexels-photo-730547.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/7821702/pexels-photo-7821702.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
  'finanzas-personales': [
    'https://images.pexels.com/photos/4968387/pexels-photo-4968387.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/3943720/pexels-photo-3943720.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/7567444/pexels-photo-7567444.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
  analisis: [
    'https://images.pexels.com/photos/6693655/pexels-photo-6693655.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/7681091/pexels-photo-7681091.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
  educacion: [
    'https://images.pexels.com/photos/5212324/pexels-photo-5212324.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/5427641/pexels-photo-5427641.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/159740/library-la-trobe-study-students-159740.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
  comparativas: [
    'https://images.pexels.com/photos/669610/pexels-photo-669610.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/590020/pexels-photo-590020.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/7681674/pexels-photo-7681674.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
  guias: [
    'https://images.pexels.com/photos/3811082/pexels-photo-3811082.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/669615/pexels-photo-669615.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/5428010/pexels-photo-5428010.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
  general: [
    'https://images.pexels.com/photos/4386339/pexels-photo-4386339.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/6801874/pexels-photo-6801874.jpeg?auto=compress&cs=tinysrgb&w=1600',
    'https://images.pexels.com/photos/3943716/pexels-photo-3943716.jpeg?auto=compress&cs=tinysrgb&w=1600',
  ],
};

// ---------------------------------------------------------------------------
// Helpers de texto
// ---------------------------------------------------------------------------
function sanitizeText(text) {
  return String(text ?? '')
    .replaceAll(/<!\[CDATA\[|\]\]>/g, '')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/&nbsp;/gi, ' ')
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;/gi, "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function firstMatch(text, regex) {
  return regex.exec(text)?.[1] ?? null;
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/(\d)[.,](\d)/g, '$1-$2')
    .replaceAll(/[^a-z0-9\s-]/g, ' ')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

function normalizeForSearch(value) {
  return sanitizeText(value)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function stableHash(input) {
  let hash = 0;
  const value = String(input ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + (value.codePointAt(i) ?? 0)) >>> 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Keywords de relevancia
// ---------------------------------------------------------------------------
const RELEVANT_KEYWORDS_PERU = ['peru', 'dolar', 'tipo de cambio', 'economia', 'finanzas', 'banco', 'sunat', 'afp', 'cts', 'inversion'];
const EXCLUDED_KEYWORDS_PERU = [
  'iran', 'israel', 'ucrania', 'guerra', 'politica internacional', 'geopolitica',
  'drones', 'bombardeo', 'erdogan', 'zelensky', 'opinion', 'editorial', 'efemerides',
  'argentina', 'buenos aires', 'rosario', 'cordoba',
  'cartelera', 'cine', 'pelicula', 'película', 'estreno', 'actor', 'actriz', 'director',
  'festival de cine', 'taquilla', 'hollywood', 'netflix', 'disney', 'hbo', 'prime video',
  'series', 'telenovela',
];
const DOLLAR_RELEVANT_KEYWORDS = ['dolar', 'tipo de cambio'];
const BANK_FINANCE_KEYWORDS = ['banco', 'bancos', 'finanzas', 'financiero', 'financiera', 'fintech', 'credito', 'inversion', 'afp', 'cts', 'sunat'];

const RELEVANT_KEYWORDS_PERU_NORMALIZED    = RELEVANT_KEYWORDS_PERU.map(normalizeForSearch);
const EXCLUDED_KEYWORDS_PERU_NORMALIZED    = EXCLUDED_KEYWORDS_PERU.map(normalizeForSearch);
const DOLLAR_RELEVANT_KEYWORDS_NORMALIZED  = DOLLAR_RELEVANT_KEYWORDS.map(normalizeForSearch);
const BANK_FINANCE_KEYWORDS_NORMALIZED     = BANK_FINANCE_KEYWORDS.map(normalizeForSearch);

const CATEGORY_KEYWORDS_NORMALIZED = Object.fromEntries(
  Object.entries(CATEGORY_KEYWORDS).map(([slug, keywords]) => [
    slug,
    [...new Set(keywords.map(normalizeForSearch).filter(Boolean))],
  ])
);

// ---------------------------------------------------------------------------
// Scoring y filtros
// ---------------------------------------------------------------------------
function getItemSearchText(item) {
  return normalizeForSearch(`${item?.title ?? ''} ${item?.excerpt ?? ''}`);
}

function includesKeyword(text, keyword) {
  if (!keyword) return false;
  if (keyword.includes(' ')) return text.includes(keyword);
  return text.split(/\s+/).includes(keyword);
}

function includesAnyKeyword(text, keywords) {
  return keywords.some((kw) => includesKeyword(text, kw));
}

function isRelevantForPeru(item) {
  const text = getItemSearchText(item);
  if (!text) return false;
  if (includesAnyKeyword(text, EXCLUDED_KEYWORDS_PERU_NORMALIZED)) return false;
  return includesAnyKeyword(text, RELEVANT_KEYWORDS_PERU_NORMALIZED);
}

function getScore(item) {
  const text = getItemSearchText(item);
  let score = 0;
  if (isRelevantForPeru(item)) score += 5;
  if (includesAnyKeyword(text, DOLLAR_RELEVANT_KEYWORDS_NORMALIZED)) score += 3;
  if (includesKeyword(text, 'peru')) score += 2;
  if (includesAnyKeyword(text, BANK_FINANCE_KEYWORDS_NORMALIZED)) score += 2;
  return score;
}

function detectIsDollarArticle(item) {
  const searchText = getItemSearchText(item);
  return DOLLAR_RELEVANT_KEYWORDS_NORMALIZED.some((kw) => searchText.includes(kw));
}

function isHighQualityItem(item) {
  const title  = sanitizeText(item.title);
  const excerpt = sanitizeText(item.excerpt);
  const titleWords = title.split(/\s+/).filter(Boolean).length;
  if (titleWords < 5 || title.length < 25) return false;
  if (excerpt.length < 40) return false;
  if (/^(video|galeria|fotogaleria)\b/i.test(title)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Deduplicación
// ---------------------------------------------------------------------------
function titleFingerprint(value) {
  const norm = normalizeForSearch(value);
  if (!norm) return '';
  return norm
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    .slice(0, 10)
    .join('|') || norm;
}

function removeSimilarTitles(items) {
  const seen = new Set();
  return items.filter((item) => {
    const fp = titleFingerprint(item.title);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}

function dedupeRecordsInBatch(records) {
  const seenSlugs = new Set();
  const seenUrls  = new Set();
  const uniqueRecords = [];
  let duplicates = 0;
  for (const record of records) {
    const keyUrl = record.source_url || '';
    if (seenSlugs.has(record.slug) || (keyUrl && seenUrls.has(keyUrl))) { duplicates++; continue; }
    seenSlugs.add(record.slug);
    if (keyUrl) seenUrls.add(keyUrl);
    uniqueRecords.push(record);
  }
  return { uniqueRecords, duplicates };
}

function dedupeRecordsAgainstCycle(records, seenCycleUrls, seenCycleTitleFingerprints) {
  const uniqueRecords = [];
  let duplicates = 0;
  for (const record of records) {
    const url = record.source_url || '';
    const fp  = titleFingerprint(record.title);
    if ((url && seenCycleUrls.has(url)) || (fp && seenCycleTitleFingerprints.has(fp))) { duplicates++; continue; }
    if (url) seenCycleUrls.add(url);
    if (fp)  seenCycleTitleFingerprints.add(fp);
    uniqueRecords.push(record);
  }
  return { uniqueRecords, duplicates };
}

// ---------------------------------------------------------------------------
// Fechas Lima
// ---------------------------------------------------------------------------
function dayKeyInLima(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return (y && m && d) ? `${y}-${m}-${d}` : null;
}

function dayIndexFromKey(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  if (!year || !month || !day) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isFreshByPublishedDate(sourcePublishedAt) {
  if (!sourcePublishedAt) return false;
  const publishedDate = new Date(sourcePublishedAt);
  if (Number.isNaN(publishedDate.getTime())) return false;
  const todayKey     = dayKeyInLima(new Date());
  const publishedKey = dayKeyInLima(publishedDate);
  if (!todayKey || !publishedKey) return false;
  const diffDays = dayIndexFromKey(todayKey) - dayIndexFromKey(publishedKey);
  return diffDays >= 0 && diffDays <= maxAgeDays;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function normalizeSourceUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    for (const key of parsed.searchParams.keys()) {
      if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    const sorted = [...parsed.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    parsed.search = '';
    for (const [k, v] of sorted) parsed.searchParams.append(k, v);
    return parsed.toString();
  } catch { return raw; }
}

// ---------------------------------------------------------------------------
// Parseo RSS
// ---------------------------------------------------------------------------
function extractItemsFromRss(xml) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const x = match[0];
    const title   = sanitizeText(firstMatch(x, /<title>([\s\S]*?)<\/title>/i));
    const link    = sanitizeText(firstMatch(x, /<link>([\s\S]*?)<\/link>/i));
    const description = sanitizeText(firstMatch(x, /<description>([\s\S]*?)<\/description>/i));
    const content = sanitizeText(firstMatch(x, /<content:encoded>([\s\S]*?)<\/content:encoded>/i) ?? description);
    const pubDate = sanitizeText(firstMatch(x, /<pubDate>([\s\S]*?)<\/pubDate>/i));
    return {
      title,
      link,
      excerpt: description || 'Borrador de noticia para parafraseo posterior.',
      bodyHtml: `<p>${content || description || 'Borrador sin contenido suficiente.'}</p>\n<p>Fuente original: <a href="${link}">${link}</a></p>`,
      sourcePublishedAt: pubDate,
    };
  });
}

function buildParagraphHtmlFromText(paragraphs) {
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Scrapers de contenido completo
// ---------------------------------------------------------------------------
async function fetchGenericFullContent(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)' },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, nav, footer, header, aside, form, iframe').remove();

    const candidates = [
      'article', 'main article', 'main', '.article-body', '.post-content',
      '.entry-content', '.story-body', '[itemprop="articleBody"]',
    ];
    let bestParagraphs = [];
    for (const selector of candidates) {
      const node = $(selector).first();
      if (!node.length) continue;
      const paragraphs = node.find('p').toArray()
        .map((el) => sanitizeText($(el).text()))
        .filter((t) => t.length >= 50);
      if (paragraphs.length > bestParagraphs.length) bestParagraphs = paragraphs;
      if (bestParagraphs.length >= 4) break;
    }
    if (bestParagraphs.length < 2) {
      bestParagraphs = $('p').toArray()
        .map((el) => sanitizeText($(el).text()))
        .filter((t) => t.length >= 60)
        .slice(0, 8);
    }
    if (bestParagraphs.length < 2 || bestParagraphs.join(' ').length < 350) return null;
    return buildParagraphHtmlFromText(bestParagraphs.slice(0, 10));
  } catch { return null; }
}

async function fetchAndinaFullContent(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)' },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const $ = cheerio.load(html);
    const main = $('.columna.linknotas');
    if (!main.length) return null;
    main.find('.iconredes, script, .Top3, #taboola-below-andina-thumbnails, .twitter-tweet, .trc_related_container').remove();
    main.find('a.ApplyClass, a[href*="/noticia-"]').remove();
    main.find('*').filter((_, el) => $(el).text().trim().toLowerCase().startsWith('más en andina')).remove();
    main.find('*').filter((_, el) => { const t = $(el).text().trim(); return t === '(FIN)' || t.startsWith('(FIN)'); }).remove();
    main.find('div').filter((_, el) => {
      const h = $(el).html() || '';
      const t = $(el).text().replaceAll(/\s+/g, '');
      return !t || /^<br\s*\/?>(<br\s*\/?\s*>)*$/.test(h.trim());
    }).remove();
    main.find('div[class*="barra-social"], div[class*="redes"], div[class*="social"]').remove();
    let content = main.html() || '';
    content = content
      .replaceAll(/(<br\s*\/?>\s*){2,}/gi, '<br>')
      .replaceAll(/\n{2,}/g, '\n')
      .replaceAll(/\s{3,}/g, ' ')
      .replace(/^(<br\s*\/?>|\s)+/, '')
      .replace(/(<br\s*\/?>|\s)+$/, '');
    return content.trim() || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// fetchFeed — con scraping paralelo
// ---------------------------------------------------------------------------
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(feed.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const xml = await response.text();
    const rawItems = extractItemsFromRss(xml);

    let items = rawItems.filter((item) =>
      item.title &&
      item.link &&
      isFreshByPublishedDate(item.sourcePublishedAt) &&
      !isClickbait(item.title) &&
      isHighQualityItem(item) &&
      isRelevantForPeru(item)
    );

    items.sort((a, b) => {
      const diff = getScore(b) - getScore(a);
      return diff !== 0 ? diff : sanitizeText(a.title).localeCompare(sanitizeText(b.title));
    });

    // ── Scraping paralelo (máx SCRAPE_CONCURRENCY simultáneos por feed) ──
    if (fullScrapeEnabled && items.length > 0) {
      const fetcher = feed.source === 'Andina' ? fetchAndinaFullContent : fetchGenericFullContent;
      await pLimit(
        items.map((item) => async () => {
          const fullHtml = await fetcher(item.link);
          if (fullHtml) item.bodyHtml = fullHtml;
        }),
        SCRAPE_CONCURRENCY
      );
    }

    return removeSimilarTitles(items).slice(0, maxPerFeed);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------
async function fetchCategoriesMap() {
  const { data, error } = await supabase.from('news_categories').select('id, slug, name');
  if (error) throw new Error(`No se pudo leer news_categories: ${error.message}`);
  const map = new Map();
  for (const cat of data ?? []) map.set(cat.slug, cat.id);
  return map;
}

function detectCategorySlug(item, availableSlugs) {
  const text     = normalizeForSearch(`${item.title} ${item.excerpt}`);
  const tokenSet = new Set(text.split(/\s+/).filter(Boolean));
  let bestSlug = null;
  let bestScore = 0;

  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS_NORMALIZED)) {
    if (!availableSlugs.has(slug)) continue;
    let score = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      if (kw.includes(' ')) { if (text.includes(kw)) score += 4; continue; }
      if (tokenSet.has(kw)) score += 3;
      else if (text.includes(kw)) score += 1;
    }
    if (score > bestScore) { bestScore = score; bestSlug = slug; }
  }

  if (bestSlug && bestScore > 0) return bestSlug;
  if (availableSlugs.has('economia')) return 'economia';
  return availableSlugs.values().next().value;
}

// ---------------------------------------------------------------------------
// Helpers de construcción de registros
// ---------------------------------------------------------------------------
function readTimeMinutes(text) {
  const words = sanitizeText(text).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function tokenizeForTags(text) {
  return sanitizeText(text)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function pickFeaturedImage(categorySlug, seedInput) {
  const pool  = FREE_IMAGE_CATALOG[categorySlug] ?? FREE_IMAGE_CATALOG.general;
  const hash  = stableHash(seedInput);
  const index = Number.parseInt(hash.slice(0, 6), 36) % pool.length;
  return pool[index];
}

function buildTags(item, categorySlug, source) {
  const ranked = new Map();
  for (const token of tokenizeForTags(`${item.title} ${item.excerpt}`)) {
    ranked.set(token, (ranked.get(token) ?? 0) + 1);
  }
  const dynamicTags = [...ranked.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 7).map(([t]) => t);
  const fixedTags = ['peru', categorySlug, slugify(source), 'actualidad-economica'].filter(Boolean);
  return [...new Set([...fixedTags, ...dynamicTags])].slice(0, 12);
}

function buildAnalysisText(item, categorySlug, source) {
  const cleanExcerpt = sanitizeText(item.excerpt).slice(0, 240);
  return [
    'Analisis editorial:',
    `Este contenido de ${source} se clasifica en ${categorySlug} por su enfoque tematico y relevancia para decisiones financieras locales.`,
    `Punto clave para el lector: ${cleanExcerpt || 'seguir la evolucion del tema y su impacto potencial en el bolsillo del consumidor.'}`,
    'Valor agregado: usa esta nota como contexto y contrastala con indicadores oficiales antes de tomar decisiones economicas.',
  ].join(' ');
}

// FIX: impact_text ahora se genera en buildArticleRecord como fallback
// para que exista incluso antes del pipeline IA. La IA lo sobreescribirá con
// un análisis de mayor calidad en runAiPublishingPipeline.
function buildImpactText(item, categorySlug, source) {
  const cleanTitle   = sanitizeText(item.title).slice(0, 120);
  const cleanExcerpt = sanitizeText(item.excerpt).slice(0, 220);
  return [
    `Impacto en Perú:`,
    `Esta noticia proveniente de ${source} tiene implicancias directas para la economía peruana en el segmento de ${categorySlug}.`,
    cleanExcerpt
      ? `En particular, "${cleanExcerpt}" refleja una tendencia que puede afectar las decisiones de consumidores, inversionistas y empresas locales.`
      : `El tema "${cleanTitle}" es relevante para el seguimiento de indicadores económicos nacionales.`,
    'Se recomienda contrastar con datos del BCRP e INEI antes de tomar decisiones financieras.',
  ].join(' ');
}

function buildArticleRecord(item, categoryId, categorySlug, source) {
  const baseSlug           = slugify(item.title).slice(0, 80) || 'noticia';
  const normalizedSourceUrl = normalizeSourceUrl(item.link);
  const uniq               = stableHash(normalizedSourceUrl || item.title).slice(0, 8);
  const slug               = `${baseSlug}-${uniq}`;
  const bodyText           = `${item.excerpt} ${item.bodyHtml}`;

  let publishedAt = new Date().toISOString();
  if (item.sourcePublishedAt) {
    const parsedDate = new Date(item.sourcePublishedAt);
    if (!Number.isNaN(parsedDate.getTime())) publishedAt = parsedDate.toISOString();
  }

  return {
    slug,
    title: item.title,
    excerpt: item.excerpt,
    body_html: item.bodyHtml,
    tags: buildTags(item, categorySlug, source),
    featured_image: pickFeaturedImage(categorySlug, `${item.link}|${item.title}`),
    analysis_text: buildAnalysisText(item, categorySlug, source),
    // FIX: impact_text incluido desde el inicio con valor de fallback
    impact_text: buildImpactText(item, categorySlug, source),
    category_id: categoryId,
    read_time_minutes: readTimeMinutes(bodyText),
    featured: false,
    author_name: `Redaccion ${source}`,
    seo_title: item.title,
    seo_description: item.excerpt.slice(0, 160),
    is_published: false,
    review_status: 'pending_review',
    reviewed_by: null,
    approved_by: null,
    approved_at: null,
    published_at: publishedAt,
    source_name: source,
    source_url: normalizedSourceUrl,
    source_type: 'media',
    source_published_at: publishedAt,
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function fetchExistingValues(field, values) {
  if (values.length === 0) return new Set();
  const { data, error } = await supabase.from('news_articles').select(field).in(field, values);
  if (error) throw new Error(`No se pudo validar ${field} existentes: ${error.message}`);
  const set = new Set();
  for (const row of data ?? []) { if (row[field]) set.add(row[field]); }
  return set;
}

async function fetchRecentTitleFingerprints() {
  const lookbackDays = Number.isFinite(Number(process.env.NEWS_DEDUPE_LOOKBACK_DAYS))
    ? Math.max(1, Number(process.env.NEWS_DEDUPE_LOOKBACK_DAYS))
    : 3;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const { data, error } = await supabase
    .from('news_articles').select('title').gte('created_at', since).limit(1200);
  if (error) throw new Error(`No se pudo leer titulos recientes: ${error.message}`);
  const set = new Set();
  for (const row of data ?? []) {
    const fp = titleFingerprint(row?.title);
    if (fp) set.add(fp);
  }
  return set;
}

async function filterExistingArticles(records, recentTitleFingerprints) {
  const sourceUrls = records.map((r) => r.source_url).filter(Boolean);
  const slugs      = records.map((r) => r.slug).filter(Boolean);
  const urlSet     = await fetchExistingValues('source_url', sourceUrls);
  const slugSet    = await fetchExistingValues('slug', slugs);

  let duplicatesFromDb = 0;
  const newRecords = records.filter((record) => {
    const fp = titleFingerprint(record.title);
    const exists = urlSet.has(record.source_url) || slugSet.has(record.slug) || (fp && recentTitleFingerprints.has(fp));
    if (exists) { duplicatesFromDb++; return false; }
    if (fp) recentTitleFingerprints.add(fp);
    return true;
  });
  return { newRecords, duplicatesFromDb };
}

function mergeTags(baseTags, aiTags) {
  return [...new Set([...(baseTags ?? []), ...(aiTags ?? [])])]
    .map((t) => sanitizeText(t).toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function buildSelectionInput(record) {
  return {
    id: record.slug,
    title: record.title,
    excerpt: record.excerpt,
    source: record.source_name,
    date: record.source_published_at,
  };
}

// ---------------------------------------------------------------------------
// Pipeline IA — con reescritura paralela y fix de impact_text
// ---------------------------------------------------------------------------
async function runAiPublishingPipeline(selectedRecords) {
  const result = { selected: selectedRecords.length, edited: 0, discardedAfterEdit: 0, published: 0, skipped: 0 };
  if (selectedRecords.length === 0) return result;

  const recordsToPublish = [];
  let dolarFeaturedAlreadySet = false;

  // Mutex liviano: dolarFeaturedAlreadySet se usa en loop paralelo,
  // protegemos con un array de resultados y asignamos featured después.
  const editResults = await pLimit(
    selectedRecords.map((draft) => async () => {
      if (isClickbait(draft.title)) {
        console.log(`[news] Rechazado por clickbait: ${draft.title.slice(0, 60)}`);
        return { draft, status: 'clickbait' };
      }
      try {
        const edited = await rewriteAndAuditArticle({ id: draft.slug, ...draft });
        if (!edited.isValid) {
          console.log(`[news] Rechazado por IA: ${edited.discardReason || 'validación fallida'}`);
          return { draft, status: 'discarded', reason: edited.discardReason };
        }
        return { draft, status: 'ok', edited };
      } catch (error) {
        console.error(`[news] Edicion IA fallo en articulo ${draft.slug}:`, error.message);
        return { draft, status: 'error' };
      }
    }),
    AI_CONCURRENCY
  );

  // Procesar resultados en orden para respetar dolarFeaturedAlreadySet
  for (const p of editResults) {
    const res = await p;
    if (!res || res.__pLimitError) continue;
    const { draft, status, edited } = res;

    if (status === 'clickbait' || status === 'discarded' || status === 'error') {
      result.discardedAfterEdit++;
      continue;
    }

    result.edited++;

    const isDollarArticle = detectIsDollarArticle(draft);
    let shouldFeature = Boolean(edited.featured);
    if (!dolarFeaturedAlreadySet && isDollarArticle && !shouldFeature) {
      shouldFeature = true;
      dolarFeaturedAlreadySet = true;
      console.log(`[news] destacado automatico asignado a articulo de dolar: ${draft.title.slice(0, 60)}`);
    }

    const editorialDisclaimer = [
      '<p><em>Este artículo ha sido reescrito y editado por IA para mejorar claridad y estructura. ',
      `Fuente original: ${draft.source_name}. `,
      'Publicado por Equipo Editorial DolarPeruHoy.</em></p>\n\n',
    ].join('');

    const reviewer = edited.reviewedBy || DEFAULT_EDITORIAL_REVIEWER;
    const publishedAt = draft.source_published_at || draft.published_at || new Date().toISOString();
    const shouldPublish = Boolean(edited.isPublished);
    const reviewStatus = shouldPublish ? 'published' : 'pending_review';

    recordsToPublish.push({
      ...draft,
      title:           edited.title           || draft.title,
      slug:            edited.slug             || draft.slug,
      excerpt:         edited.excerpt          || draft.excerpt,
      body_html:       editorialDisclaimer + (edited.bodyHtml || draft.body_html),
      analysis_text:   edited.analysisText     || draft.analysis_text,
      // FIX: impact_text se sobreescribe con el valor de la IA cuando está disponible,
      // cayendo al fallback del buildArticleRecord si la IA no lo devolvió.
      impact_text:     edited.impactText       || draft.impact_text || '',
      seo_title:       edited.seoTitle         || draft.seo_title   || draft.title,
      seo_description: edited.seoDescription   || draft.seo_description || draft.excerpt,
      tags:            mergeTags(draft.tags, edited.tags),
      read_time_minutes: Math.max(3, Number(edited.readTimeMinutes) || draft.read_time_minutes || 3),
      featured:        shouldFeature,
      author_name:     edited.authorName       || DEFAULT_EDITORIAL_REVIEWER,
      reviewed_by:     reviewer,
      approved_by:     shouldPublish ? reviewer : null,
      approved_at:     shouldPublish ? publishedAt : null,
      is_published:    shouldPublish,
      review_status:   reviewStatus,
      published_at:    publishedAt,
    });
  }

  if (recordsToPublish.length === 0) {
    result.skipped = selectedRecords.length;
    return result;
  }

  const { data, error } = await supabase
    .from('news_articles')
    .upsert(recordsToPublish, { onConflict: 'slug', ignoreDuplicates: true })
    .select('id');

  if (error) throw new Error(`Error guardando/publicando articulos seleccionados: ${error.message}`);

  result.published = data?.length ?? recordsToPublish.length;
  result.skipped  += Math.max(0, selectedRecords.length - result.published);
  return result;
}

// ---------------------------------------------------------------------------
// runCycle — con feeds en paralelo
// ---------------------------------------------------------------------------
export async function runCycle() {
  console.log(`[news] ciclo iniciado: ${new Date().toISOString()}`);

  const categoryMap = await fetchCategoriesMap();
  if (categoryMap.size === 0) {
    console.log('[news] no hay categorias en news_categories');
    return { feeds: 0, fetched: 0, inserted: 0, skipped: 0 };
  }

  if (!isAiPipelineEnabled()) {
    console.log('[news] IA deshabilitada por NEWS_AI_ENABLED. No se publica contenido.');
    return { feeds: FEEDS.length, fetched: 0, collected: 0, selected: 0, published: 0, skipped: 0 };
  }

  if (!hasOpenAiCredentials()) {
    console.log('[news] falta OPENAI_API_KEY. Se cancela el ciclo.');
    return { feeds: FEEDS.length, fetched: 0, collected: 0, selected: 0, published: 0, skipped: 0 };
  }

  let fetched = 0, inserted = 0, skipped = 0, collected = 0;
  let selected = 0, discardedBySelection = 0, published = 0, seoGenerated = 0, duplicatesTotal = 0;

  const seenCycleUrls               = new Set();
  const seenCycleTitleFingerprints  = new Set();
  const recentTitleFingerprints     = await fetchRecentTitleFingerprints();
  const allRecords                  = [];
  const availableSlugs              = new Set(categoryMap.keys());

  // ── Fetch de todos los feeds en paralelo (máx FEED_CONCURRENCY) ──
  const feedTasks = FEEDS.map((feed) => async () => {
    try {
      const items = await fetchFeed(feed);
      return { feed, items };
    } catch (error) {
      console.error(`[news] error en feed ${feed.url}:`, error.message);
      return { feed, items: [] };
    }
  });

  const feedPromises = await pLimit(feedTasks, FEED_CONCURRENCY);
  const feedResults  = await Promise.all(feedPromises);

  // ── Procesar resultados de feeds en serie (deduplicación cross-feed es stateful) ──
  for (const p of feedResults) {
    const res = await Promise.resolve(p);
    if (!res || res.__pLimitError) continue;
    const { feed, items } = res;

    fetched += items.length;

    const records = items
      .map((item) => {
        const categorySlug = detectCategorySlug(item, availableSlugs);
        const categoryId   = categoryMap.get(categorySlug);
        if (!categoryId) return null;
        return buildArticleRecord(item, categoryId, categorySlug, feed.source);
      })
      .filter(Boolean);

    if (records.length === 0) {
      console.log(`[news] ${feed.source} | leidas=${items.length} candidatas=0 duplicadas=0`);
      continue;
    }

    const { uniqueRecords, duplicates: dupBatch }    = dedupeRecordsInBatch(records);
    const { uniqueRecords: uniqCycle, duplicates: dupCycle } = dedupeRecordsAgainstCycle(
      uniqueRecords, seenCycleUrls, seenCycleTitleFingerprints
    );
    const { newRecords, duplicatesFromDb } = await filterExistingArticles(uniqCycle, recentTitleFingerprints);

    const duplicateCount = dupBatch + dupCycle + duplicatesFromDb;
    duplicatesTotal += duplicateCount;
    allRecords.push(...newRecords);
    collected += newRecords.length;
    skipped   += Math.max(0, records.length - newRecords.length);

    console.log(`[news] ${feed.source} | leidas=${items.length} candidatas=${newRecords.length} duplicadas=${duplicateCount}`);
  }

  if (allRecords.length === 0) {
    console.log('[news] ciclo terminado: sin candidatas tras limpieza y deduplicacion');
    return { feeds: FEEDS.length, fetched, collected: 0, selected: 0, discardedBySelection: 0, duplicates: duplicatesTotal, seoGenerated: 0, inserted: 0, published: 0, skipped };
  }

  // ── Selección IA (batch único) ──
  const selection     = await selectBestArticles(allRecords.map(buildSelectionInput));
  const selectedSet   = new Set(selection.selected.map((item) => item.id));
  const selectedRecords = allRecords.filter((r) => selectedSet.has(r.slug));

  selected             = selectedRecords.length;
  discardedBySelection = Math.max(0, allRecords.length - selected);

  if (selectedRecords.length === 0) {
    skipped += allRecords.length;
    console.log(`[news] seleccion IA sin resultados. resumen=${JSON.stringify(selection.summary)}`);
    return { feeds: FEEDS.length, fetched, collected, selected: 0, discardedBySelection, duplicates: duplicatesTotal, seoGenerated: 0, inserted: 0, published: 0, skipped, selectionSummary: selection.summary };
  }

  // ── Pipeline editorial IA (reescritura paralela) ──
  const recordsToProcess = selectedRecords.slice(0, MAX_AI_ARTICLES_PER_RUN);
  const aiResult         = await runAiPublishingPipeline(recordsToProcess);

  seoGenerated = aiResult.edited;
  inserted     = aiResult.published;
  published    = aiResult.published;
  skipped     += aiResult.skipped + discardedBySelection + aiResult.discardedAfterEdit;

  console.log('[news] ciclo terminado');

  return {
    feeds: FEEDS.length,
    fetched,
    collected,
    selected,
    discardedBySelection,
    duplicates: duplicatesTotal,
    seoGenerated,
    discardedAfterEdit: aiResult.discardedAfterEdit,
    inserted,
    published,
    skipped,
    selectionSummary: selection.summary,
  };
}