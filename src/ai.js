import * as cheerio from 'cheerio';

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 30000);

const ARTICLE_STRUCTURES = [
  ['contexto', 'impacto_peru', 'analisis_economico'],
  ['que_ocurrio', 'analisis', 'consecuencias'],
  ['resumen', 'impacto', 'perspectiva_futura'],
];

function sanitizeText(text) {
  return String(text ?? '')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toBooleanEnv(value, fallback) {
  if (value == null) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'si', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function isAiPipelineEnabled() {
  return toBooleanEnv(process.env.NEWS_AI_ENABLED, true);
}

export function hasOpenAiCredentials() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  const candidate = fenced ?? raw;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      return null;
    }
    const fragment = candidate.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(fragment);
    } catch {
      return null;
    }
  }
}

function stableHash(input) {
  let hash = 0;
  const value = String(input ?? '');

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + (value.codePointAt(i) ?? 0)) | 0;
  }

  return hash;
}

function pickStructure(seed) {
  const index = Math.abs(stableHash(seed)) % ARTICLE_STRUCTURES.length;
  return ARTICLE_STRUCTURES[index];
}

function countHeadings(html) {
  const $ = cheerio.load(String(html ?? ''));
  return $('h2, h3').length;
}

function validateEditorialQuality(html) {
  const $ = cheerio.load(String(html ?? ''));
  const plainText = $.text();
  const wordsArray = plainText.split(/\s+/).filter(Boolean);
  const words = wordsArray.length;
  const uniqueWords = new Set(wordsArray.map((word) => word.toLowerCase())).size;
  const uniquenessRatio = uniqueWords / Math.max(1, words);
  const headings = countHeadings(html);

  return {
    words,
    uniquenessRatio,
    headings,
    isValid: words >= 500 && uniquenessRatio >= 0.45 && headings >= 2,
  };
}

function addEditorialLayer(html, item) {
  const insights = [
    'Desde el contexto economico peruano actual, esto puede influir en decisiones financieras.',
    'Este tipo de movimientos impacta directamente en consumidores y empresas en Peru.',
    'Un punto clave es como esto se refleja en el tipo de cambio local.',
  ];

  const pick = insights[Math.abs(stableHash(item?.id ?? item?.slug ?? item?.title)) % insights.length];
  return `${String(html ?? '').trim()}\n<p><strong>Nota editorial:</strong> ${pick}</p>`;
}

function calculateContentMetrics(html) {
  const quality = validateEditorialQuality(html);

  return {
    totalWords: quality.words,
    uniqueWords: Math.round(quality.uniquenessRatio * quality.words),
    uniqueRatio: quality.uniquenessRatio,
    headings: quality.headings,
    hasSubheadings: quality.headings >= 2,
    isValid: quality.isValid,
  };
}

async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const statusCode = Number(error?.statusCode ?? 0);
      const isRetryable = statusCode === 429 || statusCode >= 500 || error?.name === 'AbortError';
      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }
      const delayMs = 1500 * (attempt + 1);
      console.log(`[ai] Reintentando en ${delayMs}ms (intento ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function openAiJson(userPrompt, systemPrompt) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          temperature: 0.2,
          max_completion_tokens: 2500,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`OpenAI HTTP ${response.status}: ${detail.slice(0, 400)}`);
        error.name = 'OpenAiHttpError';
        error.statusCode = response.status;
        throw error;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const parsed = extractJsonObject(content);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('OpenAI response did not contain valid JSON');
      }

      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  });
}

function compactArticle(article) {
  return {
    title: sanitizeText(article?.title).slice(0, 260),
    excerpt: sanitizeText(article?.excerpt).slice(0, 400),
    body: sanitizeText(article?.bodyHtml ?? article?.body_html).slice(0, 3000),
    source: sanitizeText(article?.sourceName ?? article?.source_name).slice(0, 120),
    sourceUrl: sanitizeText(article?.sourceUrl ?? article?.source_url).slice(0, 400),
  };
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

function normalizeTag(tag) {
  return sanitizeText(tag)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, ' ')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

export async function validateDraftQuality(article) {
  const minScore = clamp(Number(process.env.NEWS_AI_MIN_QUALITY_SCORE ?? 70), 40, 95);
  const data = compactArticle(article);

  const systemPrompt = [
    'Eres editor senior de noticias economicas de Peru.',
    'Debes validar calidad periodistica y utilidad para usuarios que buscan informacion economica, dolar y finanzas en Peru.',
    'Responde estrictamente JSON con keys: approved(boolean), score(number 0-100), reason(string corta).',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Evalua si vale publicar este borrador como noticia economica util en Peru.',
    acceptanceCriteria: [
      'relevancia economica para Peru',
      'claridad del titular y resumen',
      'suficiente contenido informativo y no clickbait',
      'sin contenido claramente irrelevante',
    ],
    minScore,
    article: data,
  });

  const result = await openAiJson(userPrompt, systemPrompt);

  const score = clamp(Number(result.score ?? 0), 0, 100);
  const approvedByModel = Boolean(result.approved);
  const approved = approvedByModel && score >= minScore;

  return {
    approved,
    score,
    reason: sanitizeText(result.reason).slice(0, 240) || 'Sin observaciones.',
    minScore,
  };
}

export async function generateSeoContent(article) {
  const data = compactArticle(article);

  const systemPrompt = [
    'Eres especialista SEO en medios de economia de Peru.',
    'Responde solo JSON con keys: seoTitle, seoDescription, excerpt, tags, analysisText.',
    'seoTitle max 60 chars; seoDescription max 160 chars; excerpt 130-220 chars;',
    'tags debe ser array de 6 a 10 tags en minusculas y formato slug (sin tildes, sin espacios, usar guion).',
    'analysisText 220-480 chars con foco util para lector peruano.',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Genera campos SEO listos para publicacion automatica.',
    article: data,
  });

  const result = await openAiJson(userPrompt, systemPrompt);

  const tags = Array.isArray(result.tags)
    ? result.tags
      .map((tag) => sanitizeText(tag)
        .normalize('NFD')
        .replaceAll(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s-]/g, ' ')
        .replaceAll(/\s+/g, '-')
        .replaceAll(/-+/g, '-')
        .replaceAll(/^-|-$/g, '')
      )
      .filter(Boolean)
    : [];

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: sanitizeText(result.seoTitle).slice(0, 60),
      description: sanitizeText(result.seoDescription).slice(0, 160),
      datePublished: new Date().toISOString(),
      dateModified: new Date().toISOString(),
      author: { '@type': 'Organization', name: 'Equipo Editorial DolarPeruHoy' },
      publisher: {
        '@type': 'Organization',
        name: 'DolarPeruHoy',
        logo: { '@type': 'ImageObject', url: 'https://dolarperuhoy.com/logo.png' },
      },
    };

  return {
    seoTitle: sanitizeText(result.seoTitle).slice(0, 60),
    seoDescription: sanitizeText(result.seoDescription).slice(0, 160),
    excerpt: sanitizeText(result.excerpt).slice(0, 220),
    tags: [...new Set(tags)].slice(0, 10),
    analysisText: sanitizeText(result.analysisText).slice(0, 480),
      structuredData,
  };
}

function compactSelectionArticle(article) {
  return {
    id: sanitizeText(article?.id).slice(0, 80),
    title: sanitizeText(article?.title).slice(0, 260),
    excerpt: sanitizeText(article?.excerpt).slice(0, 260),
    source: sanitizeText(article?.source).slice(0, 120),
    date: sanitizeText(article?.date).slice(0, 80),
  };
}

function normalizeTitleKey(value) {
  return sanitizeText(value)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function resolveArticleId(item, allowedIds, titleToId) {
  const directId = sanitizeText(item?.id ?? item?.articleId ?? item?.slug);
  if (directId && allowedIds.has(directId)) {
    return directId;
  }

  const byTitle = titleToId.get(normalizeTitleKey(item?.title));
  if (byTitle && allowedIds.has(byTitle)) {
    return byTitle;
  }

  return null;
}

function normalizeSelectionResult(result, allowedIds, titleToId) {
  const selected = toArray(result?.selected)
    .map((item) => {
      const id = resolveArticleId(item, allowedIds, titleToId);
      if (!id) {
        return null;
      }

      return {
        id,
        title: sanitizeText(item?.title).slice(0, 260),
        reason: sanitizeText(item?.reason).slice(0, 220),
        topic: sanitizeText(item?.topic).slice(0, 120),
        score: clamp(Number(item?.score ?? item?.priority ?? 0), 0, 100),
      };
    })
    .filter(Boolean);

  const uniqueSelected = [];
  const selectedSet = new Set();
  for (const item of selected) {
    if (selectedSet.has(item.id)) {
      continue;
    }
    selectedSet.add(item.id);
    uniqueSelected.push(item);
  }

  const discarded = toArray(result?.discarded)
    .map((item) => {
      const id = resolveArticleId(item, allowedIds, titleToId);
      if (!id || selectedSet.has(id)) {
        return null;
      }

      return {
        id,
        title: sanitizeText(item?.title).slice(0, 260),
        reason: sanitizeText(item?.reason).slice(0, 220),
        topic: sanitizeText(item?.topic).slice(0, 120),
      };
    })
    .filter(Boolean);

  return {
    selected: uniqueSelected,
    discarded,
    summary: {
      requested: allowedIds.size,
      selected: uniqueSelected.length,
      discarded: discarded.length,
      focus: sanitizeText(result?.summary?.focus).slice(0, 180),
      notes: sanitizeText(result?.summary?.notes).slice(0, 260),
    },
  };
}

export async function selectBestArticles(articles) {
  const compact = toArray(articles)
    .map(compactSelectionArticle)
    .filter((item) => item.id && item.title);

  if (compact.length === 0) {
    return {
      selected: [],
      discarded: [],
      summary: { requested: 0, selected: 0, discarded: 0, notes: 'Sin articulos elegibles.' },
    };
  }

  const allowedIds = new Set(compact.map((item) => item.id));
  const titleToId = new Map(
    compact.map((item) => [normalizeTitleKey(item.title), item.id])
  );

  const systemPrompt = [
    'Eres editor SEO senior de un portal financiero peruano.',
    'Analiza un lote de noticias RSS y selecciona SOLO las mejores para publicar.',
    'Prioriza noticias economicas relevantes para Peru.',
    'Detecta duplicados SEMANTICOS y elige solo la mejor version.',
    'Selecciona entre 4 y 6 noticias de mayor calidad.',
    'Prioridades altas: dolar, tipo de cambio, BCRP, inflacion, mineria, bancos, AFP, SUNAT, tasas, inversion, exportaciones, empresas, consumo, empleo y economia peruana.',
    'Descarta deportes, farandula, policiales, clima, clickbait y noticias sin impacto economico en Peru.',
    'Evita seleccionar multiples noticias casi iguales.',
    'Prioriza utilidad, claridad, potencial SEO y diversidad tematica.',
    'Responde SOLO JSON valido.',
    'Formato exacto:',
    '{"selected":[{"title":"","reason":"","topic":"","score":0}],"discarded":[{"title":"","reason":"","topic":""}],"summary":{"focus":"","notes":""}}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Selecciona las mejores noticias economicas para publicar hoy.',
    constraints: {
      minSelected: 4,
      maxSelected: 6,
      semanticDeduplication: true,
      strictJson: true,
    },
    articles: compact,
  });

  try {
    const raw = await openAiJson(userPrompt, systemPrompt);
    const normalized = normalizeSelectionResult(raw, allowedIds, titleToId);

    if (normalized.selected.length === 0) {
      return {
        selected: [],
        discarded: compact.map((item) => ({ id: item.id, reason: 'No seleccionado por IA.' })),
        summary: {
          requested: compact.length,
          selected: 0,
          discarded: compact.length,
          notes: 'IA no devolvio seleccion util.',
        },
      };
    }

    return normalized;
  } catch (error) {
    const statusCode = Number(error?.statusCode ?? 0);
    const retryable = statusCode === 429 || statusCode >= 500;

    return {
      selected: [],
      discarded: [],
      failed: true,
      retryable,
      summary: {
        requested: compact.length,
        selected: 0,
        discarded: 0,
        notes: `Error OpenAI: ${sanitizeText(error?.message).slice(0, 240)}`,
        errorCode: statusCode || undefined,
        retryable,
      },
    };
  }
}

export async function rewriteAndAuditArticle(article) {
  const selectedStructure = pickStructure(article?.id ?? article?.slug ?? article?.title);

  const data = {
    id: sanitizeText(article?.id ?? article?.slug).slice(0, 100),
    title: sanitizeText(article?.title).slice(0, 260),
    excerpt: sanitizeText(article?.excerpt).slice(0, 500),
    source: sanitizeText(article?.source_name ?? article?.source).slice(0, 120),
    date: sanitizeText(article?.source_published_at ?? article?.date).slice(0, 80),
    html: String(article?.body_html ?? article?.bodyHtml ?? '').slice(0, 12000),
  };

  const systemPrompt = [
    'Actua como un redactor financiero senior, editor SEO y auditor de calidad editorial especializado en noticias de economia y finanzas en Peru.',
    'Recibiras un ID de registro y el HTML completo de una noticia obtenida por scraping.',
    'Tu objetivo es decidir si la noticia tiene suficiente calidad editorial y potencial SEO para publicarse en DolarPeruHoy.',
    'FASE 1 VALIDACION ESTRICTA: si no cumple, devolver como no apta. Descarta contenido corto, basura, incoherente, irrelevante para economia peruana, demasiado internacional sin impacto Peru, espectaculos/deportes/farandula, clickbait o sin valor editorial.',
    'CASO DOLAR: si trata de tipo de cambio, no descartes por simplicidad; agrega contexto, causas e impacto economico local.',
    'FASE 2 REESCRITURA EDITORIAL: genera texto original, no resumen ni copia. Sin inventar cifras/declaraciones/estadisticas/proyecciones.',
    'No repetir estructuras entre articulos consecutivos.',
    'Variar orden de secciones en cada articulo.',
    'No usar siempre los mismos subtitulos.',
    'Incluir al menos un elemento variable: dato, contexto o implicancia.',
    `ESTRUCTURA OBLIGATORIA para este articulo (orden exacto): ${selectedStructure.join(' -> ')}.`,
    'Minimo 3000 caracteres, minimo 500 palabras, minimo 2 subtitulos H2/H3, excelente legibilidad.',
    'Usa solo etiquetas HTML: <p>, <h2>, <h3>, <ul>, <li>, <strong>. Sin scripts, iframes, embeds, publicidad o menciones al medio fuente.',
    'REGLAS DE SALIDA: devolver SOLO JSON valido y parseable. Nunca markdown. Nunca texto adicional.',
    'Formato JSON exacto:',
    '{"is_valid":true,"discard_reason":"","title":"","slug":"","excerpt":"","body_html":"","analysis_text":"","impact_text":"","seo_title":"","seo_description":"","tags":[""],"read_time_minutes":3,"featured":false,"is_published":true,"is_discarded":false,"author_name":"Equipo DolarPeruHoy","reviewed_by":"Equipo Editorial DolarPeruHoy"}',
    'Si no es apta devuelve: {"is_valid":false,"discard_reason":"..."}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Audita calidad y reescribe articulo para publicacion editorial.',
    input: data,
    estructura_obligatoria: selectedStructure,
    constraints: {
      minWords: 500,
      minBodyChars: 3000,
      excerptMinChars: 140,
      excerptMaxChars: 220,
      seoTitleMaxChars: 70,
      seoDescriptionMaxChars: 160,
      titleMaxChars: 90,
      readTimeMin: 3,
      htmlTagsAllowed: ['p', 'h2', 'h3', 'ul', 'li', 'strong'],
    },
  });

  const raw = await openAiJson(userPrompt, systemPrompt);

  if (!raw?.is_valid) {
    return {
      isValid: false,
      discardReason: sanitizeText(raw?.discard_reason).slice(0, 240) || 'No apta editorialmente.',
    };
  }

  const quality = validateEditorialQuality(raw?.body_html ?? '');
  if (quality.words < 500) {
    return {
      isValid: false,
      discardReason: 'Contenido muy corto (< 500 palabras). Rechazado por bajo valor.',
    };
  }
  if (quality.uniquenessRatio < 0.45) {
    return {
      isValid: false,
      discardReason: 'Contenido con insuficientes palabras únicas. Potencial relleno detectado.',
    };
  }
  if (quality.headings < 2) {
    return {
      isValid: false,
      discardReason: 'Contenido sin estructura de subtitulos (< 2 H2/H3). Mejora necesaria.',
    };
  }

  const tags = toArray(raw?.tags)
    .map(normalizeTag)
    .filter(Boolean)
    .slice(0, 8);

  const title = sanitizeText(raw?.title).slice(0, 90);
  const seoTitle = sanitizeText(raw?.seo_title).slice(0, 70);
  const seoDescription = sanitizeText(raw?.seo_description).slice(0, 160);
  const excerpt = sanitizeText(raw?.excerpt).slice(0, 220);
  const bodyHtml = addEditorialLayer(raw?.body_html ?? '', data);
  const metrics = calculateContentMetrics(bodyHtml);
  const analysisText = sanitizeText(raw?.analysis_text);
  const impactText = sanitizeText(raw?.impact_text);

  return {
    isValid: true,
    discardReason: '',
    title: title || data.title,
    slug: slugify(raw?.slug || title || data.title).slice(0, 120) || data.id || 'noticia-economia',
    excerpt: excerpt || data.excerpt,
    bodyHtml,
    analysisText,
    impactText,
    seoTitle: seoTitle || title || data.title,
    seoDescription: seoDescription || data.excerpt,
    tags: [...new Set(tags)],
    readTimeMinutes: Math.max(3, Number(raw?.read_time_minutes) || 3),
    featured: Boolean(raw?.featured),
    isPublished: false,
    isDiscarded: Boolean(raw?.is_discarded),
    authorName: sanitizeText(raw?.author_name) || 'Equipo Editorial DolarPeruHoy',
    reviewedBy: sanitizeText(raw?.reviewed_by) || 'Equipo Editorial DolarPeruHoy',
    contentMetrics: metrics,
  };
}