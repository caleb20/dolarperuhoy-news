import { supabase } from './supabase.js';
const timeoutMs = Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 15000);
const maxPerFeed = Number(process.env.NEWS_MAX_PER_FEED ?? 10);
const runOnceDaily = process.env.NEWS_RUN_ONCE_DAILY !== 'false';
const forceRun = process.env.NEWS_FORCE_RUN === '1';

const FEEDS = [
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
];

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
    .replaceAll(/[^a-z0-9\s-]/g, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

function readTimeMinutes(text) {
  const words = sanitizeText(text).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function stableHash(input) {
  let hash = 0;
  const value = String(input ?? '');

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + (value.codePointAt(i) ?? 0)) >>> 0;
  }

  return hash.toString(36);
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
    const items = extractItemsFromRss(xml)
      .filter((item) => item.title && item.link)
      .slice(0, maxPerFeed);

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
  const text = `${item.title} ${item.excerpt}`.toLowerCase();

  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (!availableSlugs.has(slug)) {
      continue;
    }

    if (keywords.some((keyword) => text.includes(keyword))) {
      return slug;
    }
  }

  if (availableSlugs.has('economia')) {
    return 'economia';
  }

  return availableSlugs.values().next().value;
}

function buildArticleRecord(item, categoryId, source) {
  const baseSlug = slugify(item.title).slice(0, 80) || 'noticia';
  const uniq = stableHash(item.link || item.title).slice(0, 8);
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
    category_id: categoryId,
    read_time_minutes: readTimeMinutes(bodyText),
    featured: false,
    author_name: `Redaccion ${source}`,
    seo_title: item.title,
    seo_description: item.excerpt.slice(0, 160),
    is_published: false,
    published_at: publishedAt,
    source_name: source,
    source_url: item.link,
    source_type: 'media',
    source_published_at: publishedAt,
  };
}

async function alreadyRanToday() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('news_articles')
    .select('id')
    .ilike('author_name', 'Redaccion %')
    .gte('created_at', start.toISOString())
    .limit(1);

  if (error) {
    throw new Error(`No se pudo validar corrida diaria: ${error.message}`);
  }

  return (data?.length ?? 0) > 0;
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

async function filterExistingArticles(records) {
  const sourceUrls = records
    .map((record) => record.source_url)
    .filter(Boolean);

  const slugs = records
    .map((record) => record.slug)
    .filter(Boolean);

  const urlSet = await fetchExistingValues('source_url', sourceUrls);
  const slugSet = await fetchExistingValues('slug', slugs);

  return records.filter(
    (record) => !urlSet.has(record.source_url) && !slugSet.has(record.slug)
  );
}

export async function runCycle() {
  console.log(`[news] ciclo iniciado: ${new Date().toISOString()}`);

  if (runOnceDaily && !forceRun) {
    const hasRun = await alreadyRanToday();
    if (hasRun) {
      console.log('[news] ya se ejecuto hoy, se omite corrida diaria');
      return { feeds: FEEDS.length, fetched: 0, inserted: 0, skipped: 0 };
    }
  }

  const categoryMap = await fetchCategoriesMap();

  if (categoryMap.size === 0) {
    console.log('[news] no hay categorias en news_categories');
    return { feeds: 0, fetched: 0, inserted: 0, skipped: 0 };
  }

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;

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

          return buildArticleRecord(item, categoryId, feed.source);
        })
        .filter(Boolean);

      if (records.length === 0) {
        continue;
      }

      const newRecords = await filterExistingArticles(records);

      if (newRecords.length === 0) {
        skipped += records.length;
        console.log(`[news] ${feed.source} | leidas=${items.length} insertadas=0`);
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
        `[news] ${feed.source} | leidas=${items.length} insertadas=${data?.length ?? 0}`
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