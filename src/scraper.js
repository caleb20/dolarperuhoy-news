import { supabase } from './supabase.js';
const timeoutMs = Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 15000);
const maxPerFeed = Number(process.env.NEWS_MAX_PER_FEED ?? 6);
const maxAgeDays = Number.isFinite(Number(process.env.NEWS_MAX_AGE_DAYS))
  ? Math.max(0, Number(process.env.NEWS_MAX_AGE_DAYS))
  : 0;
const TRACKING_QUERY_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'igshid',
]);

const BASE_FEEDS = [
  {
    source: 'El Comercio',
    url: 'https://elcomercio.pe/arc/outboundfeeds/rss/category/economia/?outputType=xml',
  },
  {
    source: 'El Comercio',
    url: 'https://elcomercio.pe/arc/outboundfeeds/rss/category/mundo/?outputType=xml',
  },
  {
    source: 'El Comercio',
    url: 'https://elcomercio.pe/arc/outboundfeeds/rss/category/tecnologia/?outputType=xml',
  },
  {
    source: 'Gestion',
    url: 'https://gestion.pe/arc/outboundfeeds/rss/category/economia/?outputType=xml',
  },
  {
    source: 'Gestion',
    url: 'https://gestion.pe/arc/outboundfeeds/rss/category/mercados/?outputType=xml',
  },
  {
    source: 'Andina',
    url: 'https://andina.pe/agencia/rssnoticias.aspx',
  },
  {
    source: 'Andina',
    url: 'https://andina.pe/agencia/rsseconomia.aspx',
  },
  {
    source: 'Andina',
    url: 'https://andina.pe/agencia/rsspolitica.aspx',
  },
  {
    source: 'Andina',
    url: 'https://andina.pe/agencia/rssdeportes.aspx',
  },
  {
    source: 'RPP',
    url: 'https://rpp.pe/rss',
  },
  {
    source: 'La Republica',
    url: 'https://larepublica.pe/rss/economia.xml',
  },
];

function parseExtraFeedsFromEnv() {
  const raw = String(process.env.NEWS_EXTRA_FEEDS ?? '').trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => ({
        source: sanitizeText(item?.source),
        url: String(item?.url ?? '').trim(),
      }))
      .filter((item) => item.source && /^https?:\/\//i.test(item.url));
  } catch {
    return [];
  }
}

function mergeFeeds(baseFeeds, extraFeeds) {
  const merged = [];
  const seen = new Set();

  for (const feed of [...baseFeeds, ...extraFeeds]) {
    if (!feed?.source || !feed?.url) {
      continue;
    }

    const key = `${feed.source.toLowerCase()}|${feed.url.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(feed);
  }

  return merged;
}

const FEEDS = mergeFeeds(BASE_FEEDS, parseExtraFeedsFromEnv());

const CATEGORY_KEYWORDS = {
  'finanzas-personales': [
    'ahorro', 'credito', 'crédito', 'tarjeta', 'hipoteca', 'sueldo', 'presupuesto',
    'inversion', 'inversión', 'afp', 'cts', 'gratificacion', 'gratificación', 'deuda',
  ],
  educacion: [
    'colegio', 'universidad', 'estudiante', 'docente', 'beca', 'sunedu',
    'escolar', 'examen', 'maestro',
  ],
  comparativas: [
    'comparativa', 'comparar', 'versus', 'vs', 'ranking', 'mejor', 'peor',
    'diferencia', 'conviene',
  ],
  analisis: [
    'analisis', 'análisis', 'opinion', 'opinión', 'editorial', 'columna',
    'perspectiva', 'claves',
  ],
  guias: [
    'guia', 'guía', 'como', 'cómo', 'paso a paso', 'requisitos',
    'tramite', 'trámite', 'tutorial',
  ],
  economia: [
    'economia', 'economía', 'inflacion', 'inflación', 'bcr', 'dolar', 'dólar',
    'tipo de cambio', 'mercado', 'pbi', 'empleo',
  ],
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

function firstMatch(text, regex) {
  const match = regex.exec(text);
  return match?.[1] ?? null;
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

const RELEVANT_KEYWORDS_PERU = [
  'peru',
  'dolar',
  'tipo de cambio',
  'economia',
  'finanzas',
  'banco',
  'sunat',
  'afp',
  'cts',
  'inversion',
];

const EXCLUDED_KEYWORDS_PERU = [
  'iran',
  'israel',
  'ucrania',
  'guerra',
  'drones',
  'bombardeo',
  'erdogan',
  'zelensky',
  'opinion',
  'editorial',
  'efemerides',
];

const DOLLAR_RELEVANT_KEYWORDS = ['dolar', 'tipo de cambio'];
const BANK_FINANCE_KEYWORDS = [
  'banco',
  'bancos',
  'finanzas',
  'financiero',
  'financiera',
  'fintech',
  'credito',
  'inversion',
  'afp',
  'cts',
  'sunat',
];

const RELEVANT_KEYWORDS_PERU_NORMALIZED = RELEVANT_KEYWORDS_PERU.map((keyword) =>
  normalizeForSearch(keyword)
);
const EXCLUDED_KEYWORDS_PERU_NORMALIZED = EXCLUDED_KEYWORDS_PERU.map((keyword) =>
  normalizeForSearch(keyword)
);
const DOLLAR_RELEVANT_KEYWORDS_NORMALIZED = DOLLAR_RELEVANT_KEYWORDS.map((keyword) =>
  normalizeForSearch(keyword)
);
const BANK_FINANCE_KEYWORDS_NORMALIZED = BANK_FINANCE_KEYWORDS.map((keyword) =>
  normalizeForSearch(keyword)
);

const CATEGORY_KEYWORDS_NORMALIZED = Object.fromEntries(
  Object.entries(CATEGORY_KEYWORDS).map(([slug, keywords]) => [
    slug,
    [...new Set(keywords.map((keyword) => normalizeForSearch(keyword)).filter(Boolean))],
  ])
);

function getItemSearchText(item) {
  return normalizeForSearch(`${item?.title ?? ''} ${item?.excerpt ?? ''}`);
}

function includesKeyword(text, keyword) {
  if (!keyword) {
    return false;
  }

  if (keyword.includes(' ')) {
    return text.includes(keyword);
  }

  return text.split(/\s+/).includes(keyword);
}

function includesAnyKeyword(text, keywords) {
  return keywords.some((keyword) => includesKeyword(text, keyword));
}

function titleFingerprint(value) {
  const normalizedTitle = normalizeForSearch(value);
  if (!normalizedTitle) {
    return '';
  }

  return normalizedTitle
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
    .slice(0, 10)
    .join('|') || normalizedTitle;
}

function isRelevantForPeru(item) {
  const text = getItemSearchText(item);
  if (!text) {
    return false;
  }

  if (includesAnyKeyword(text, EXCLUDED_KEYWORDS_PERU_NORMALIZED)) {
    return false;
  }

  return includesAnyKeyword(text, RELEVANT_KEYWORDS_PERU_NORMALIZED);
}

function getScore(item) {
  const text = getItemSearchText(item);
  let score = 0;

  if (isRelevantForPeru(item)) {
    score += 5;
  }

  if (includesAnyKeyword(text, DOLLAR_RELEVANT_KEYWORDS_NORMALIZED)) {
    score += 3;
  }

  if (includesKeyword(text, 'peru')) {
    score += 2;
  }

  if (includesAnyKeyword(text, BANK_FINANCE_KEYWORDS_NORMALIZED)) {
    score += 2;
  }

  return score;
}

function removeSimilarTitles(items) {
  const seenFingerprints = new Set();
  const uniqueItems = [];

  for (const item of items) {
    const fingerprint = titleFingerprint(item.title);

    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenFingerprints.add(fingerprint);
    uniqueItems.push(item);
  }

  return uniqueItems;
}

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
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function stableHash(input) {
  let hash = 0;
  const value = String(input ?? '');

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + (value.codePointAt(i) ?? 0)) >>> 0;
  }

  return hash.toString(36);
}

function pickFeaturedImage(categorySlug, seedInput) {
  const pool = FREE_IMAGE_CATALOG[categorySlug] ?? FREE_IMAGE_CATALOG.general;
  const hash = stableHash(seedInput);
  const index = Number.parseInt(hash.slice(0, 6), 36) % pool.length;
  return pool[index];
}

function buildTags(item, categorySlug, source) {
  const ranked = new Map();

  for (const token of tokenizeForTags(`${item.title} ${item.excerpt}`)) {
    ranked.set(token, (ranked.get(token) ?? 0) + 1);
  }

  const dynamicTags = [...ranked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([token]) => token);

  const fixedTags = [
    'peru',
    categorySlug,
    slugify(source),
    'actualidad-economica',
  ].filter(Boolean);

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

function normalizeSourceUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = '';

    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    const sorted = [...parsed.searchParams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));

    parsed.search = '';
    for (const [key, value] of sorted) {
      parsed.searchParams.append(key, value);
    }

    return parsed.toString();
  } catch {
    return raw;
  }
}

function isHighQualityItem(item) {
  const title = sanitizeText(item.title);
  const excerpt = sanitizeText(item.excerpt);
  const titleWords = title.split(/\s+/).filter(Boolean).length;

  if (titleWords < 5 || title.length < 25) {
    return false;
  }

  if (excerpt.length < 40) {
    return false;
  }

  if (/^(video|galeria|fotogaleria)\b/i.test(title)) {
    return false;
  }

  return true;
}

function dedupeRecordsInBatch(records) {
  const seenSlugs = new Set();
  const seenUrls = new Set();
  const uniqueRecords = [];
  let duplicates = 0;

  for (const record of records) {
    const keyUrl = record.source_url || '';
    if (seenSlugs.has(record.slug) || (keyUrl && seenUrls.has(keyUrl))) {
      duplicates += 1;
      continue;
    }

    seenSlugs.add(record.slug);
    if (keyUrl) {
      seenUrls.add(keyUrl);
    }
    uniqueRecords.push(record);
  }

  return { uniqueRecords, duplicates };
}

function dayKeyInLima(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function dayIndexFromKey(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isFreshByPublishedDate(sourcePublishedAt) {
  if (!sourcePublishedAt) {
    return false;
  }

  const publishedDate = new Date(sourcePublishedAt);
  if (Number.isNaN(publishedDate.getTime())) {
    return false;
  }

  const todayKey = dayKeyInLima(new Date());
  const publishedKey = dayKeyInLima(publishedDate);
  if (!todayKey || !publishedKey) {
    return false;
  }

  const todayIndex = dayIndexFromKey(todayKey);
  const publishedIndex = dayIndexFromKey(publishedKey);
  if (todayIndex == null || publishedIndex == null) {
    return false;
  }

  const diffDays = todayIndex - publishedIndex;
  return diffDays >= 0 && diffDays <= maxAgeDays;
}

function extractItemsFromRss(xml) {
  const itemMatches = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)];

  return itemMatches.map((match) => {
    const itemXml = match[0];
    const title = sanitizeText(firstMatch(itemXml, /<title>([\s\S]*?)<\/title>/i));
    const link = sanitizeText(firstMatch(itemXml, /<link>([\s\S]*?)<\/link>/i));
    const description = sanitizeText(
      firstMatch(itemXml, /<description>([\s\S]*?)<\/description>/i)
    );
    const content = sanitizeText(
      firstMatch(itemXml, /<content:encoded>([\s\S]*?)<\/content:encoded>/i) ?? description
    );
    const pubDate = sanitizeText(firstMatch(itemXml, /<pubDate>([\s\S]*?)<\/pubDate>/i));

    return {
      title,
      link,
      excerpt: description || 'Borrador de noticia para parafraseo posterior.',
      bodyHtml: `<p>${content || description || 'Borrador sin contenido suficiente.'}</p>\n<p>Fuente original: <a href="${link}">${link}</a></p>`,
      sourcePublishedAt: pubDate,
    };
  });
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(feed.url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DolarPeruHoyNewsBot/1.0)',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const items = removeSimilarTitles(
      extractItemsFromRss(xml)
      .filter((item) => item.title && item.link)
      .filter((item) => isFreshByPublishedDate(item.sourcePublishedAt))
      .filter((item) => isHighQualityItem(item))
      .filter((item) => isRelevantForPeru(item))
      .sort((a, b) => {
        const scoreDiff = getScore(b) - getScore(a);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return sanitizeText(a.title).localeCompare(sanitizeText(b.title));
      })
    ).slice(0, maxPerFeed);

    return items;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCategoriesMap() {
  const { data, error } = await supabase
    .from('news_categories')
    .select('id, slug, name');

  if (error) {
    throw new Error(`No se pudo leer news_categories: ${error.message}`);
  }

  const map = new Map();
  for (const category of data ?? []) {
    map.set(category.slug, category.id);
  }
  return map;
}

function detectCategorySlug(item, availableSlugs) {
  const text = normalizeForSearch(`${item.title} ${item.excerpt}`);
  const tokenSet = new Set(text.split(/\s+/).filter(Boolean));
  let bestSlug = null;
  let bestScore = 0;

  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS_NORMALIZED)) {
    if (!availableSlugs.has(slug)) {
      continue;
    }

    let score = 0;
    for (const keyword of keywords) {
      if (!keyword) {
        continue;
      }

      if (keyword.includes(' ')) {
        if (text.includes(keyword)) {
          score += 4;
        }
        continue;
      }

      if (tokenSet.has(keyword)) {
        score += 3;
      } else if (text.includes(keyword)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSlug = slug;
    }
  }

  if (bestSlug && bestScore > 0) {
    return bestSlug;
  }

  if (availableSlugs.has('economia')) {
    return 'economia';
  }

  return availableSlugs.values().next().value;
}

function buildArticleRecord(item, categoryId, categorySlug, source) {
  const baseSlug = slugify(item.title).slice(0, 80) || 'noticia';
  const normalizedSourceUrl = normalizeSourceUrl(item.link);
  const uniq = stableHash(normalizedSourceUrl || item.title).slice(0, 8);
  const slug = `${baseSlug}-${uniq}`;

  const bodyText = `${item.excerpt} ${item.bodyHtml}`;

  let publishedAt = new Date().toISOString();
  if (item.sourcePublishedAt) {
    const parsedDate = new Date(item.sourcePublishedAt);
    if (!Number.isNaN(parsedDate.getTime())) {
      publishedAt = parsedDate.toISOString();
    }
  }

  return {
    slug,
    title: item.title,
    excerpt: item.excerpt,
    body_html: item.bodyHtml,
    tags: buildTags(item, categorySlug, source),
    featured_image: pickFeaturedImage(categorySlug, `${item.link}|${item.title}`),
    analysis_text: buildAnalysisText(item, categorySlug, source),
    category_id: categoryId,
    read_time_minutes: readTimeMinutes(bodyText),
    featured: false,
    author_name: `Redaccion ${source}`,
    seo_title: item.title,
    seo_description: item.excerpt.slice(0, 160),
    is_published: false,
    published_at: publishedAt,
    source_name: source,
    source_url: normalizedSourceUrl,
    source_type: 'media',
    source_published_at: publishedAt,
  };
}

async function fetchExistingValues(field, values) {
  if (values.length === 0) {
    return new Set();
  }

  const { data, error } = await supabase
    .from('news_articles')
    .select(field)
    .in(field, values);

  if (error) {
    throw new Error(`No se pudo validar ${field} existentes: ${error.message}`);
  }

  const set = new Set();
  for (const row of data ?? []) {
    if (row[field]) {
      set.add(row[field]);
    }
  }

  return set;
}

async function fetchRecentTitleFingerprints() {
  const lookbackDays = Number.isFinite(Number(process.env.NEWS_DEDUPE_LOOKBACK_DAYS))
    ? Math.max(1, Number(process.env.NEWS_DEDUPE_LOOKBACK_DAYS))
    : 3;

  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('news_articles')
    .select('title')
    .gte('created_at', since)
    .limit(1200);

  if (error) {
    throw new Error(`No se pudo leer titulos recientes: ${error.message}`);
  }

  const seenFingerprints = new Set();
  for (const row of data ?? []) {
    const fingerprint = titleFingerprint(row?.title);
    if (fingerprint) {
      seenFingerprints.add(fingerprint);
    }
  }

  return seenFingerprints;
}

function dedupeRecordsAgainstCycle(records, seenCycleUrls, seenCycleTitleFingerprints) {
  const uniqueRecords = [];
  let duplicates = 0;

  for (const record of records) {
    const url = record.source_url || '';
    const fingerprint = titleFingerprint(record.title);

    const existsInCycle = (url && seenCycleUrls.has(url)) || (fingerprint && seenCycleTitleFingerprints.has(fingerprint));

    if (existsInCycle) {
      duplicates += 1;
      continue;
    }

    if (url) {
      seenCycleUrls.add(url);
    }
    if (fingerprint) {
      seenCycleTitleFingerprints.add(fingerprint);
    }

    uniqueRecords.push(record);
  }

  return { uniqueRecords, duplicates };
}

async function filterExistingArticles(records, recentTitleFingerprints) {
  const sourceUrls = records
    .map((record) => record.source_url)
    .filter(Boolean);

  const slugs = records
    .map((record) => record.slug)
    .filter(Boolean);

  const urlSet = await fetchExistingValues('source_url', sourceUrls);
  const slugSet = await fetchExistingValues('slug', slugs);

  let duplicatesFromDb = 0;
  const newRecords = records.filter((record) => {
    const recordTitleFingerprint = titleFingerprint(record.title);
    const exists =
      urlSet.has(record.source_url) ||
      slugSet.has(record.slug) ||
      (recordTitleFingerprint && recentTitleFingerprints.has(recordTitleFingerprint));

    if (exists) {
      duplicatesFromDb += 1;
      return false;
    }

    if (recordTitleFingerprint) {
      recentTitleFingerprints.add(recordTitleFingerprint);
    }

    return true;
  });

  return { newRecords, duplicatesFromDb };
}

export async function runCycle() {
  console.log(`[news] ciclo iniciado: ${new Date().toISOString()}`);

  const categoryMap = await fetchCategoriesMap();

  if (categoryMap.size === 0) {
    console.log('[news] no hay categorias en news_categories');
    return { feeds: 0, fetched: 0, inserted: 0, skipped: 0 };
  }

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  const seenCycleUrls = new Set();
  const seenCycleTitleFingerprints = new Set();
  const recentTitleFingerprints = await fetchRecentTitleFingerprints();

  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      fetched += items.length;

      const availableSlugs = new Set(categoryMap.keys());
      const records = items
        .map((item) => {
          const categorySlug = detectCategorySlug(item, availableSlugs);
          const categoryId = categoryMap.get(categorySlug);

          if (!categoryId) {
            return null;
          }

          return buildArticleRecord(item, categoryId, categorySlug, feed.source);
        })
        .filter(Boolean);

      if (records.length === 0) {
        continue;
      }

      const { uniqueRecords, duplicates: duplicatesInBatch } = dedupeRecordsInBatch(records);
      const { uniqueRecords: uniqueRecordsInCycle, duplicates: duplicatesInCycle } = dedupeRecordsAgainstCycle(
        uniqueRecords,
        seenCycleUrls,
        seenCycleTitleFingerprints
      );
      const { newRecords, duplicatesFromDb } = await filterExistingArticles(
        uniqueRecordsInCycle,
        recentTitleFingerprints
      );
      const duplicateCount = duplicatesInBatch + duplicatesInCycle + duplicatesFromDb;

      if (newRecords.length === 0) {
        skipped += records.length;
        console.log(
          `[news] ${feed.source} | leidas=${items.length} insertadas=0 duplicadas=${duplicateCount}`
        );
        continue;
      }

      const { data, error } = await supabase
        .from('news_articles')
        .upsert(newRecords, { onConflict: 'slug', ignoreDuplicates: true })
        .select('id');

      if (error) {
        console.error(`[news] error guardando ${feed.source}:`, error.message);
        skipped += newRecords.length;
        continue;
      }

      inserted += data?.length ?? 0;
      skipped += Math.max(0, records.length - (data?.length ?? 0));

      console.log(
        `[news] ${feed.source} | leidas=${items.length} insertadas=${data?.length ?? 0} duplicadas=${duplicateCount}`
      );
    } catch (error) {
      console.error(`[news] error en feed ${feed.url}:`, error.message);
    }
  }

  console.log('[news] ciclo terminado');

  return {
    feeds: FEEDS.length,
    fetched,
    inserted,
    skipped,
  };
}