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

// Alineado con maxSelected de selectBestArticles (8).
// Ajusta con NEWS_MAX_AI_ARTICLES_PER_RUN en .env para controlar costos.
const MAX_AI_ARTICLES_PER_RUN = Number(process.env.NEWS_MAX_AI_ARTICLES_PER_RUN ?? 8);

const DEFAULT_EDITORIAL_REVIEWER = process.env.NEWS_DEFAULT_REVIEWER?.trim() || 'Equipo Editorial DolarPeruHoy';

const SCRAPE_CONCURRENCY = Number(process.env.NEWS_SCRAPE_CONCURRENCY ?? 3);
const FEED_CONCURRENCY   = Number(process.env.NEWS_FEED_CONCURRENCY   ?? 4);
const AI_CONCURRENCY     = Number(process.env.NEWS_AI_CONCURRENCY     ?? 3);

const CLICKBAIT_PATTERNS = [
  /\b(increíble|impactante|shock|no vas a creer|revelado|filtrado)\b/i,
  /(\?{2,}|!{3,})/,
  /\b(te sorprenderá|lo que nadie dice)\b/i,
];
function isClickbait(text) { return CLICKBAIT_PATTERNS.some(p => p.test(String(text ?? ''))); }

const fullScrapeEnabled = !['0','false','no','off'].includes(
  String(process.env.NEWS_FULL_SCRAPE_ENABLED ?? 'true').trim().toLowerCase()
);

const TRACKING_QUERY_KEYS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','igshid']);

// ---------------------------------------------------------------------------
// pLimit: concurrencia controlada
// ---------------------------------------------------------------------------
async function pLimit(tasks, limit) {
  const results = [];
  const queue = [...tasks];
  const executing = new Set();

  async function runNext() {
    if (!queue.length) return;
    const task = queue.shift();
    const p = Promise.resolve().then(() => task()).catch(err => ({ __pLimitError: true, err })).finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);
    if (executing.size < limit) runNext();
    await p;
    runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => runNext()));
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
    return parsed.map(i => ({ source: sanitizeText(i?.source), url: String(i?.url ?? '').trim() }))
      .filter(i => i.source && /^https?:\/\//i.test(i.url));
  } catch { return []; }
}

function mergeFeeds(base, extra) {
  const seen = new Set();
  return [...base, ...extra].filter(f => {
    if (!f?.source || !f?.url) return false;
    const k = `${f.source.toLowerCase()}|${f.url.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const FEEDS = mergeFeeds(BASE_FEEDS, parseExtraFeedsFromEnv());

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  'finanzas-personales': ['ahorro','credito','crédito','tarjeta','hipoteca','sueldo','presupuesto','inversion','inversión','afp','cts','gratificacion','gratificación','deuda'],
  educacion: ['colegio','universidad','estudiante','docente','beca','sunedu','escolar','examen','maestro'],
  comparativas: ['comparativa','comparar','versus','vs','ranking','mejor','peor','diferencia','conviene'],
  analisis: ['analisis','análisis','opinion','opinión','editorial','columna','perspectiva','claves'],
  guias: ['guia','guía','como','cómo','paso a paso','requisitos','tramite','trámite','tutorial'],
  economia: ['economia','economía','inflacion','inflación','bcr','dolar','dólar','tipo de cambio','mercado','pbi','empleo'],
};

const STOPWORDS = new Set(['a','al','algo','ante','con','contra','como','cual','de','del','desde','donde','dos','el','ella','ellas','ellos','en','entre','era','es','esa','ese','eso','esta','este','esto','fue','ha','hay','la','las','lo','los','mas','me','mi','mis','muy','no','nos','o','para','pero','por','que','se','si','sin','sobre','su','sus','te','tu','un','una','uno','y']);

const FREE_IMAGE_CATALOG = {
  economia: ['https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/730547/pexels-photo-730547.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/7821702/pexels-photo-7821702.jpeg?auto=compress&cs=tinysrgb&w=1600'],
  'finanzas-personales': ['https://images.pexels.com/photos/4968387/pexels-photo-4968387.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/3943720/pexels-photo-3943720.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/7567444/pexels-photo-7567444.jpeg?auto=compress&cs=tinysrgb&w=1600'],
  analisis: ['https://images.pexels.com/photos/6693655/pexels-photo-6693655.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/7681091/pexels-photo-7681091.jpeg?auto=compress&cs=tinysrgb&w=1600'],
  educacion: ['https://images.pexels.com/photos/5212324/pexels-photo-5212324.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/5427641/pexels-photo-5427641.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/159740/library-la-trobe-study-students-159740.jpeg?auto=compress&cs=tinysrgb&w=1600'],
  comparativas: ['https://images.pexels.com/photos/669610/pexels-photo-669610.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/590020/pexels-photo-590020.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/7681674/pexels-photo-7681674.jpeg?auto=compress&cs=tinysrgb&w=1600'],
  guias: ['https://images.pexels.com/photos/3811082/pexels-photo-3811082.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/669615/pexels-photo-669615.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/5428010/pexels-photo-5428010.jpeg?auto=compress&cs=tinysrgb&w=1600'],
  general: ['https://images.pexels.com/photos/4386339/pexels-photo-4386339.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/6801874/pexels-photo-6801874.jpeg?auto=compress&cs=tinysrgb&w=1600','https://images.pexels.com/photos/3943716/pexels-photo-3943716.jpeg?auto=compress&cs=tinysrgb&w=1600'],
};

// ---------------------------------------------------------------------------
// Helpers de texto
// ---------------------------------------------------------------------------
function sanitizeText(text) {
  return String(text ?? '').replaceAll(/<!\[CDATA\[|\]\]>/g,'').replaceAll(/<[^>]*>/g,' ').replaceAll(/&nbsp;/gi,' ').replaceAll(/&amp;/gi,'&').replaceAll(/&quot;/gi,'"').replaceAll(/&#39;/gi,"'").replaceAll(/\s+/g,' ').trim();
}
function escapeHtml(text) {
  return String(text ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}
function firstMatch(text, regex) { return regex.exec(text)?.[1] ?? null; }

function slugify(value) {
  return String(value ?? '').normalize('NFD').replaceAll(/[\u0300-\u036f]/g,'').toLowerCase()
    .replaceAll(/(\d)[.,](\d)/g,'$1-$2').replaceAll(/[^a-z0-9\s-]/g,' ')
    .replaceAll(/\s+/g,'-').replaceAll(/-+/g,'-').replaceAll(/^-|-$/g,'');
}
function normalizeForSearch(value) {
  return sanitizeText(value).normalize('NFD').replaceAll(/[\u0300-\u036f]/g,'').toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g,' ').replaceAll(/\s+/g,' ').trim();
}
function stableHash(input) {
  let hash = 0;
  for (let i = 0; i < String(input ?? '').length; i++) hash = (hash * 31 + (String(input)[i].codePointAt(0) ?? 0)) >>> 0;
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------
const RELEVANT_KEYWORDS_PERU   = ['peru','dolar','tipo de cambio','economia','finanzas','banco','sunat','afp','cts','inversion'];
const EXCLUDED_KEYWORDS_PERU   = ['iran','israel','ucrania','guerra','politica internacional','geopolitica','drones','bombardeo','erdogan','zelensky','opinion','editorial','efemerides','argentina','buenos aires','rosario','cordoba','cartelera','cine','pelicula','película','estreno','actor','actriz','director','festival de cine','taquilla','hollywood','netflix','disney','hbo','prime video','series','telenovela'];
const DOLLAR_RELEVANT_KEYWORDS = ['dolar','tipo de cambio'];
const BANK_FINANCE_KEYWORDS    = ['banco','bancos','finanzas','financiero','financiera','fintech','credito','inversion','afp','cts','sunat'];

const RELEVANT_NORM   = RELEVANT_KEYWORDS_PERU.map(normalizeForSearch);
const EXCLUDED_NORM   = EXCLUDED_KEYWORDS_PERU.map(normalizeForSearch);
const DOLLAR_NORM     = DOLLAR_RELEVANT_KEYWORDS.map(normalizeForSearch);
const BANK_NORM       = BANK_FINANCE_KEYWORDS.map(normalizeForSearch);

const CATEGORY_KEYWORDS_NORMALIZED = Object.fromEntries(
  Object.entries(CATEGORY_KEYWORDS).map(([slug, kws]) => [slug, [...new Set(kws.map(normalizeForSearch).filter(Boolean))]])
);

function getItemSearchText(item) { return normalizeForSearch(`${item?.title ?? ''} ${item?.excerpt ?? ''}`); }
function includesKeyword(text, kw) { if (!kw) return false; return kw.includes(' ') ? text.includes(kw) : text.split(/\s+/).includes(kw); }
function includesAnyKeyword(text, kws) { return kws.some(kw => includesKeyword(text, kw)); }

function isRelevantForPeru(item) {
  const text = getItemSearchText(item);
  if (!text || includesAnyKeyword(text, EXCLUDED_NORM)) return false;
  return includesAnyKeyword(text, RELEVANT_NORM);
}
function getScore(item) {
  const text = getItemSearchText(item);
  let score = 0;
  if (isRelevantForPeru(item)) score += 5;
  if (includesAnyKeyword(text, DOLLAR_NORM)) score += 3;
  if (includesKeyword(text, 'peru')) score += 2;
  if (includesAnyKeyword(text, BANK_NORM)) score += 2;
  return score;
}
function detectIsDollarArticle(item) { return DOLLAR_NORM.some(kw => getItemSearchText(item).includes(kw)); }
function isHighQualityItem(item) {
  const title = sanitizeText(item.title), excerpt = sanitizeText(item.excerpt);
  if (title.split(/\s+/).filter(Boolean).length < 5 || title.length < 25) return false;
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
  return norm.split(/\s+/).filter(t => t.length >= 4 && !STOPWORDS.has(t)).slice(0,10).join('|') || norm;
}
function removeSimilarTitles(items) {
  const seen = new Set();
  return items.filter(item => { const fp = titleFingerprint(item.title); if (seen.has(fp)) return false; seen.add(fp); return true; });
}
function dedupeRecordsInBatch(records) {
  const seenSlugs = new Set(), seenUrls = new Set(), unique = []; let dups = 0;
  for (const r of records) {
    const url = r.source_url || '';
    if (seenSlugs.has(r.slug) || (url && seenUrls.has(url))) { dups++; continue; }
    seenSlugs.add(r.slug); if (url) seenUrls.add(url); unique.push(r);
  }
  return { uniqueRecords: unique, duplicates: dups };
}
function dedupeRecordsAgainstCycle(records, seenUrls, seenFps) {
  const unique = []; let dups = 0;
  for (const r of records) {
    const url = r.source_url || '', fp = titleFingerprint(r.title);
    if ((url && seenUrls.has(url)) || (fp && seenFps.has(fp))) { dups++; continue; }
    if (url) seenUrls.add(url); if (fp) seenFps.add(fp); unique.push(r);
  }
  return { uniqueRecords: unique, duplicates: dups };
}

// ---------------------------------------------------------------------------
// Fechas Lima
// ---------------------------------------------------------------------------
function dayKeyInLima(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const y = parts.find(p => p.type==='year')?.value, m = parts.find(p => p.type==='month')?.value, d = parts.find(p => p.type==='day')?.value;
  return (y && m && d) ? `${y}-${m}-${d}` : null;
}
function dayIndexFromKey(k) {
  const [y,m,d] = String(k).split('-').map(Number);
  return (!y||!m||!d) ? null : Math.floor(Date.UTC(y,m-1,d)/86400000);
}
function isFreshByPublishedDate(src) {
  if (!src) return false;
  const d = new Date(src);
  if (isNaN(d.getTime())) return false;
  const tk = dayKeyInLima(new Date()), pk = dayKeyInLima(d);
  if (!tk || !pk) return false;
  const diff = dayIndexFromKey(tk) - dayIndexFromKey(pk);
  return diff >= 0 && diff <= maxAgeDays;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function normalizeSourceUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const p = new URL(raw);
    p.hash = '';
    for (const k of p.searchParams.keys()) if (TRACKING_QUERY_KEYS.has(k.toLowerCase())) p.searchParams.delete(k);
    const sorted = [...p.searchParams.entries()].sort((a,b) => a[0].localeCompare(b[0]));
    p.search = '';
    for (const [k,v] of sorted) p.searchParams.append(k,v);
    return p.toString();
  } catch { return raw; }
}

// ---------------------------------------------------------------------------
// Parseo RSS
// ---------------------------------------------------------------------------
function extractItemsFromRss(xml) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => {
    const x = m[0];
    const title   = sanitizeText(firstMatch(x, /<title>([\s\S]*?)<\/title>/i));
    const link    = sanitizeText(firstMatch(x, /<link>([\s\S]*?)<\/link>/i));
    const desc    = sanitizeText(firstMatch(x, /<description>([\s\S]*?)<\/description>/i));
    const content = sanitizeText(firstMatch(x, /<content:encoded>([\s\S]*?)<\/content:encoded>/i) ?? desc);
    const pubDate = sanitizeText(firstMatch(x, /<pubDate>([\s\S]*?)<\/pubDate>/i));
    return { title, link, excerpt: desc || 'Borrador de noticia para parafraseo posterior.', bodyHtml: `<p>${content || desc || 'Borrador sin contenido suficiente.'}</p>\n<p>Fuente original: <a href="${link}">${link}</a></p>`, sourcePublishedAt: pubDate };
  });
}

function buildParagraphHtmlFromText(paragraphs) { return paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('\n').trim(); }

// ---------------------------------------------------------------------------
// Scrapers
// ---------------------------------------------------------------------------
async function fetchGenericFullContent(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)' } });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    $('script,style,noscript,nav,footer,header,aside,form,iframe').remove();
    const candidates = ['article','main article','main','.article-body','.post-content','.entry-content','.story-body','[itemprop="articleBody"]'];
    let best = [];
    for (const sel of candidates) {
      const node = $(sel).first();
      if (!node.length) continue;
      const ps = node.find('p').toArray().map(el => sanitizeText($(el).text())).filter(t => t.length >= 50);
      if (ps.length > best.length) best = ps;
      if (best.length >= 4) break;
    }
    if (best.length < 2) best = $('p').toArray().map(el => sanitizeText($(el).text())).filter(t => t.length >= 60).slice(0,8);
    if (best.length < 2 || best.join(' ').length < 350) return null;
    return buildParagraphHtmlFromText(best.slice(0,10));
  } catch { return null; }
}

async function fetchAndinaFullContent(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)' } });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const main = $('.columna.linknotas');
    if (!main.length) return null;
    main.find('.iconredes,script,.Top3,#taboola-below-andina-thumbnails,.twitter-tweet,.trc_related_container').remove();
    main.find('a.ApplyClass,a[href*="/noticia-"]').remove();
    main.find('*').filter((_,el) => $(el).text().trim().toLowerCase().startsWith('más en andina')).remove();
    main.find('*').filter((_,el) => { const t = $(el).text().trim(); return t === '(FIN)' || t.startsWith('(FIN)'); }).remove();
    main.find('div').filter((_,el) => { const h = $(el).html()||'', t = $(el).text().replaceAll(/\s+/g,''); return !t || /^<br\s*\/?>(<br\s*\/?\s*>)*$/.test(h.trim()); }).remove();
    main.find('div[class*="barra-social"],div[class*="redes"],div[class*="social"]').remove();
    let content = (main.html()||'').replaceAll(/(<br\s*\/?>\s*){2,}/gi,'<br>').replaceAll(/\n{2,}/g,'\n').replaceAll(/\s{3,}/g,' ').replace(/^(<br\s*\/?>|\s)+/,'').replace(/(<br\s*\/?>|\s)+$/,'');
    return content.trim() || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// fetchFeed con scraping paralelo
// ---------------------------------------------------------------------------
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let items = extractItemsFromRss(await res.text()).filter(item =>
      item.title && item.link && isFreshByPublishedDate(item.sourcePublishedAt) &&
      !isClickbait(item.title) && isHighQualityItem(item) && isRelevantForPeru(item)
    );
    items.sort((a,b) => { const d = getScore(b)-getScore(a); return d !== 0 ? d : sanitizeText(a.title).localeCompare(sanitizeText(b.title)); });
    if (fullScrapeEnabled && items.length) {
      const fetcher = feed.source === 'Andina' ? fetchAndinaFullContent : fetchGenericFullContent;
      await pLimit(items.map(item => async () => { const h = await fetcher(item.link); if (h) item.bodyHtml = h; }), SCRAPE_CONCURRENCY);
    }
    return removeSimilarTitles(items).slice(0, maxPerFeed);
  } finally { clearTimeout(timeout); }
}

// ---------------------------------------------------------------------------
// Categorías DB
// ---------------------------------------------------------------------------
async function fetchCategoriesMap() {
  const { data, error } = await supabase.from('news_categories').select('id, slug, name');
  if (error) throw new Error(`No se pudo leer news_categories: ${error.message}`);
  const map = new Map();
  for (const cat of data ?? []) map.set(cat.slug, cat.id);
  return map;
}

function detectCategorySlug(item, availableSlugs) {
  const text = normalizeForSearch(`${item.title} ${item.excerpt}`);
  const tokenSet = new Set(text.split(/\s+/).filter(Boolean));
  let bestSlug = null, bestScore = 0;
  for (const [slug, kws] of Object.entries(CATEGORY_KEYWORDS_NORMALIZED)) {
    if (!availableSlugs.has(slug)) continue;
    let score = 0;
    for (const kw of kws) { if (!kw) continue; if (kw.includes(' ')) { if (text.includes(kw)) score += 4; } else if (tokenSet.has(kw)) score += 3; else if (text.includes(kw)) score += 1; }
    if (score > bestScore) { bestScore = score; bestSlug = slug; }
  }
  if (bestSlug && bestScore > 0) return bestSlug;
  return availableSlugs.has('economia') ? 'economia' : availableSlugs.values().next().value;
}

// ---------------------------------------------------------------------------
// Construcción de registros
// ---------------------------------------------------------------------------
function readTimeMinutes(text) { return Math.max(1, Math.ceil(sanitizeText(text).split(/\s+/).filter(Boolean).length / 220)); }

function tokenizeForTags(text) {
  return sanitizeText(text).normalize('NFD').replaceAll(/[\u0300-\u036f]/g,'').toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

function pickFeaturedImage(categorySlug, seed) {
  const pool = FREE_IMAGE_CATALOG[categorySlug] ?? FREE_IMAGE_CATALOG.general;
  return pool[Number.parseInt(stableHash(seed).slice(0,6), 36) % pool.length];
}

function buildTags(item, categorySlug, source) {
  const ranked = new Map();
  for (const t of tokenizeForTags(`${item.title} ${item.excerpt}`)) ranked.set(t, (ranked.get(t)??0)+1);
  const dynamic = [...ranked.entries()].sort((a,b)=>b[1]-a[1]).slice(0,7).map(([t])=>t);
  return [...new Set(['peru', categorySlug, slugify(source), 'actualidad-economica', ...dynamic].filter(Boolean))].slice(0,12);
}

function buildAnalysisText(item, categorySlug, source) {
  const excerpt = sanitizeText(item.excerpt).slice(0,240);
  return `Analisis editorial: Este contenido de ${source} se clasifica en ${categorySlug} por su enfoque tematico y relevancia para decisiones financieras locales. Punto clave: ${excerpt || 'seguir la evolucion del tema y su impacto en el bolsillo del consumidor.'}`;
}

function buildImpactText(item, categorySlug, source) {
  const title = sanitizeText(item.title).slice(0,120);
  const excerpt = sanitizeText(item.excerpt).slice(0,220);
  return `Impacto en Perú: Esta noticia de ${source} tiene implicancias para la economía peruana en ${categorySlug}. ${excerpt ? `"${excerpt}" refleja una tendencia que puede afectar consumidores, inversionistas y empresas locales.` : `El tema "${title}" es relevante para indicadores económicos nacionales.`} Se recomienda contrastar con datos del BCRP e INEI antes de tomar decisiones financieras.`;
}

function buildArticleRecord(item, categoryId, categorySlug, source) {
  const baseSlug = slugify(item.title).slice(0,80) || 'noticia';
  const normalizedUrl = normalizeSourceUrl(item.link);
  const slug = `${baseSlug}-${stableHash(normalizedUrl || item.title).slice(0,8)}`;
  let publishedAt = new Date().toISOString();
  if (item.sourcePublishedAt) { const d = new Date(item.sourcePublishedAt); if (!isNaN(d.getTime())) publishedAt = d.toISOString(); }

  return {
    slug, title: item.title, excerpt: item.excerpt, body_html: item.bodyHtml,
    tags: buildTags(item, categorySlug, source),
    featured_image: pickFeaturedImage(categorySlug, `${item.link}|${item.title}`),
    analysis_text: buildAnalysisText(item, categorySlug, source),
    impact_text: buildImpactText(item, categorySlug, source),
    category_id: categoryId,
    read_time_minutes: readTimeMinutes(`${item.excerpt} ${item.bodyHtml}`),
    featured: false,
    author_name: `Redaccion ${source}`,
    seo_title: item.title,
    seo_description: item.excerpt.slice(0,160),
    is_published: false,
    review_status: 'pending_review',
    reviewed_by: null, approved_by: null, approved_at: null,
    published_at: publishedAt,
    source_name: source, source_url: normalizedUrl,
    source_type: 'media', source_published_at: publishedAt,
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function fetchExistingValues(field, values) {
  if (!values.length) return new Set();
  const { data, error } = await supabase.from('news_articles').select(field).in(field, values);
  if (error) throw new Error(`No se pudo validar ${field}: ${error.message}`);
  const set = new Set();
  for (const row of data ?? []) if (row[field]) set.add(row[field]);
  return set;
}

async function fetchRecentTitleFingerprints() {
  const days = Number.isFinite(Number(process.env.NEWS_DEDUPE_LOOKBACK_DAYS)) ? Math.max(1, Number(process.env.NEWS_DEDUPE_LOOKBACK_DAYS)) : 3;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase.from('news_articles').select('title').gte('created_at', since).limit(1200);
  if (error) throw new Error(`No se pudo leer titulos recientes: ${error.message}`);
  const set = new Set();
  for (const row of data ?? []) { const fp = titleFingerprint(row?.title); if (fp) set.add(fp); }
  return set;
}

async function filterExistingArticles(records, recentFps) {
  const urls = records.map(r => r.source_url).filter(Boolean);
  const slugs = records.map(r => r.slug).filter(Boolean);
  const urlSet = await fetchExistingValues('source_url', urls);
  const slugSet = await fetchExistingValues('slug', slugs);
  let dups = 0;
  const newRecords = records.filter(r => {
    const fp = titleFingerprint(r.title);
    if (urlSet.has(r.source_url) || slugSet.has(r.slug) || (fp && recentFps.has(fp))) { dups++; return false; }
    if (fp) recentFps.add(fp);
    return true;
  });
  return { newRecords, duplicatesFromDb: dups };
}

function mergeTags(base, ai) {
  return [...new Set([...(base??[]),...(ai??[])])].map(t => sanitizeText(t).toLowerCase()).filter(Boolean).slice(0,12);
}

function buildSelectionInput(r) {
  return { id: r.slug, title: r.title, excerpt: r.excerpt, source: r.source_name, date: r.source_published_at };
}

// ---------------------------------------------------------------------------
// Pipeline IA — reescritura paralela
// ---------------------------------------------------------------------------
async function runAiPublishingPipeline(selectedRecords) {
  const result = { selected: selectedRecords.length, edited: 0, discardedAfterEdit: 0, published: 0, skipped: 0 };
  if (!selectedRecords.length) return result;

  const recordsToPublish = [];
  let dolarFeaturedAlreadySet = false;

  const editResults = await pLimit(
    selectedRecords.map(draft => async () => {
      if (isClickbait(draft.title)) {
        console.log(`[news] Rechazado por clickbait: ${draft.title.slice(0,60)}`);
        return { draft, status: 'clickbait' };
      }
      try {
        const edited = await rewriteAndAuditArticle({ id: draft.slug, ...draft });
        if (!edited.isValid) {
          console.log(`[news] Rechazado por IA: ${edited.discardReason || 'validación fallida'}`);
          return { draft, status: 'discarded', edited };
        }
        return { draft, status: 'ok', edited };
      } catch (error) {
        console.error(`[news] Edicion IA fallo en ${draft.slug}:`, error.message);
        return { draft, status: 'error' };
      }
    }),
    AI_CONCURRENCY
  );

  const recordsDiscarded = [];
  for (const p of editResults) {
    const res = await p;
    if (!res || res.__pLimitError) continue;
    const { draft, status, edited } = res;
    if (status !== 'ok') {
      result.discardedAfterEdit++;
      if (status === 'discarded' || status === 'clickbait') {
        recordsDiscarded.push({
          ...draft,
          is_discarded: true,
          is_published: false,
          review_status: 'rejected',
          reviewed_by: DEFAULT_EDITORIAL_REVIEWER,
          approved_by: null,
          approved_at: null,
        });
      }
      continue;
    }
    result.edited++;

    const isDollar = detectIsDollarArticle(draft);
    let shouldFeature = Boolean(edited.featured);
    if (!dolarFeaturedAlreadySet && isDollar && !shouldFeature) {
      shouldFeature = true; dolarFeaturedAlreadySet = true;
      console.log(`[news] destacado automatico: ${draft.title.slice(0,60)}`);
    }

    const reviewer = edited.reviewedBy || DEFAULT_EDITORIAL_REVIEWER;
    const publishedAt = draft.source_published_at || draft.published_at || new Date().toISOString();
    const shouldPublish = Boolean(edited.isPublished);

    recordsToPublish.push({
      ...draft,
      title:           edited.title           || draft.title,
      slug:            edited.slug             || draft.slug,
      excerpt:         edited.excerpt          || draft.excerpt,
      body_html:       edited.bodyHtml         || draft.body_html,
      analysis_text:   edited.analysisText     || draft.analysis_text,
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
      review_status:   shouldPublish ? 'published' : 'pending_review',
      published_at:    publishedAt,
    });
  }

  if (recordsDiscarded.length) {
    const { error: discardError } = await supabase.from('news_articles').upsert(
      recordsDiscarded,
      { onConflict: 'slug', ignoreDuplicates: false }
    );
    if (discardError) console.warn('[news] Error guardando descartados:', discardError.message);
    else console.log(`[news] ${recordsDiscarded.length} articulos marcados is_discarded=true en DB.`);
  }

  if (!recordsToPublish.length) { result.skipped = selectedRecords.length; return result; }

  const { data, error } = await supabase.from('news_articles').upsert(recordsToPublish, { onConflict: 'slug', ignoreDuplicates: true }).select('id');
  if (error) throw new Error(`Error guardando articulos: ${error.message}`);

  result.published = data?.length ?? recordsToPublish.length;
  result.skipped  += Math.max(0, selectedRecords.length - result.published);
  return result;
}

// ---------------------------------------------------------------------------
// runCycle
// ---------------------------------------------------------------------------
export async function runCycle() {
  console.log(`[news] ciclo iniciado: ${new Date().toISOString()}`);

  const categoryMap = await fetchCategoriesMap();
  if (!categoryMap.size) { console.log('[news] no hay categorias en news_categories'); return { feeds: 0, fetched: 0, inserted: 0, skipped: 0 }; }
  if (!isAiPipelineEnabled()) { console.log('[news] IA deshabilitada.'); return { feeds: FEEDS.length, fetched: 0, collected: 0, selected: 0, published: 0, skipped: 0 }; }
  if (!hasOpenAiCredentials()) { console.log('[news] falta OPENAI_API_KEY.'); return { feeds: FEEDS.length, fetched: 0, collected: 0, selected: 0, published: 0, skipped: 0 }; }

  let fetched = 0, inserted = 0, skipped = 0, collected = 0, selected = 0, discardedBySelection = 0, published = 0, seoGenerated = 0, duplicatesTotal = 0;
  const seenUrls = new Set(), seenFps = new Set();
  const recentFps = await fetchRecentTitleFingerprints();
  const allRecords = [];
  const availableSlugs = new Set(categoryMap.keys());

  // Feeds en paralelo
  const feedResults = await pLimit(
    FEEDS.map(feed => async () => {
      try { return { feed, items: await fetchFeed(feed) }; }
      catch (err) { console.error(`[news] error en feed ${feed.url}:`, err.message); return { feed, items: [] }; }
    }),
    FEED_CONCURRENCY
  );

  // Procesar resultados en serie (deduplicación stateful)
  for (const p of feedResults) {
    const res = await Promise.resolve(p);
    if (!res || res.__pLimitError) continue;
    const { feed, items } = res;
    fetched += items.length;

    const records = items.map(item => {
      const slug = detectCategorySlug(item, availableSlugs);
      const id   = categoryMap.get(slug);
      return id ? buildArticleRecord(item, id, slug, feed.source) : null;
    }).filter(Boolean);

    if (!records.length) { console.log(`[news] ${feed.source} | leidas=${items.length} candidatas=0 duplicadas=0`); continue; }

    const { uniqueRecords: u1, duplicates: d1 } = dedupeRecordsInBatch(records);
    const { uniqueRecords: u2, duplicates: d2 } = dedupeRecordsAgainstCycle(u1, seenUrls, seenFps);
    const { newRecords, duplicatesFromDb } = await filterExistingArticles(u2, recentFps);

    const dupCount = d1 + d2 + duplicatesFromDb;
    duplicatesTotal += dupCount;
    allRecords.push(...newRecords);
    collected += newRecords.length;
    skipped   += Math.max(0, records.length - newRecords.length);
    console.log(`[news] ${feed.source} | leidas=${items.length} candidatas=${newRecords.length} duplicadas=${dupCount}`);
  }

  if (!allRecords.length) {
    console.log('[news] ciclo terminado: sin candidatas');
    return { feeds: FEEDS.length, fetched, collected: 0, selected: 0, discardedBySelection: 0, duplicates: duplicatesTotal, seoGenerated: 0, inserted: 0, published: 0, skipped };
  }

  const selection = await selectBestArticles(allRecords.map(buildSelectionInput));
  const selectedSet = new Set(selection.selected.map(i => i.id));
  const selectedRecords = allRecords.filter(r => selectedSet.has(r.slug));

  selected             = selectedRecords.length;
  discardedBySelection = Math.max(0, allRecords.length - selected);

  if (!selectedRecords.length) {
    skipped += allRecords.length;
    console.log(`[news] seleccion IA sin resultados. resumen=${JSON.stringify(selection.summary)}`);
    return { feeds: FEEDS.length, fetched, collected, selected: 0, discardedBySelection, duplicates: duplicatesTotal, seoGenerated: 0, inserted: 0, published: 0, skipped, selectionSummary: selection.summary };
  }

  const aiResult = await runAiPublishingPipeline(selectedRecords.slice(0, MAX_AI_ARTICLES_PER_RUN));
  seoGenerated = aiResult.edited;
  inserted     = aiResult.published;
  published    = aiResult.published;
  skipped     += aiResult.skipped + discardedBySelection + aiResult.discardedAfterEdit;

  console.log('[news] ciclo terminado');
  return { feeds: FEEDS.length, fetched, collected, selected, discardedBySelection, duplicates: duplicatesTotal, seoGenerated, discardedAfterEdit: aiResult.discardedAfterEdit, inserted, published, skipped, selectionSummary: selection.summary };
}