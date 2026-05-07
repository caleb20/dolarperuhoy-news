import * as cheerio from 'cheerio';

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 30000);
const editorialMinWords = clamp(Number(process.env.NEWS_EDITORIAL_MIN_WORDS ?? 380), 250, 900);
const editorialMinUniqueRatio = clamp(Number(process.env.NEWS_EDITORIAL_MIN_UNIQUENESS_RATIO ?? 0.38), 0.25, 0.7);
const editorialMinHeadings = clamp(Number(process.env.NEWS_EDITORIAL_MIN_HEADINGS ?? 2), 1, 4);
const openAiMaxRetries = clamp(Number(process.env.OPENAI_MAX_RETRIES ?? 2), 1, 5);
const openAiRetryBaseMs = clamp(Number(process.env.OPENAI_RETRY_BASE_MS ?? 1000), 100, 5000);
const openAiMaxOutputTokens = clamp(Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 2500), 400, 6000);
// Timeout extendido para selectBestArticles (batch grande, más tokens de entrada)
const selectionTimeoutMs = Number(process.env.OPENAI_SELECTION_TIMEOUT_MS ?? timeoutMs * 2);

// Longitud mínima de impact_text exigida al modelo
const IMPACT_TEXT_MIN_CHARS = clamp(Number(process.env.NEWS_IMPACT_TEXT_MIN_CHARS ?? 180), 80, 600);
const IMPACT_TEXT_MAX_CHARS = clamp(Number(process.env.NEWS_IMPACT_TEXT_MAX_CHARS ?? 520), 200, 1000);
const ANALYSIS_TEXT_MIN_CHARS = clamp(Number(process.env.NEWS_ANALYSIS_TEXT_MIN_CHARS ?? 180), 80, 600);
const ANALYSIS_TEXT_MAX_CHARS = clamp(Number(process.env.NEWS_ANALYSIS_TEXT_MAX_CHARS ?? 520), 200, 1000);

const ARTICLE_STRUCTURES = [
  ['contexto', 'impacto_peru', 'analisis_economico'],
  ['que_ocurrio', 'analisis', 'consecuencias'],
  ['resumen', 'impacto', 'perspectiva_futura'],
];

// ---------------------------------------------------------------------------
// Helpers básicos
// ---------------------------------------------------------------------------
function sanitizeText(text) {
  return String(text ?? '')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(input) {
  let hash = 0;
  const value = String(input ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + (value.codePointAt(i) ?? 0)) | 0;
  }
  return hash;
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

// ---------------------------------------------------------------------------
// Estructura del artículo
// ---------------------------------------------------------------------------
function pickStructure(seed) {
  const index = Math.abs(stableHash(seed)) % ARTICLE_STRUCTURES.length;
  return ARTICLE_STRUCTURES[index];
}

// ---------------------------------------------------------------------------
// Validación editorial de HTML
// ---------------------------------------------------------------------------
function countHeadings(html) {
  const $ = cheerio.load(String(html ?? ''));
  return $('h2, h3').length;
}

function validateEditorialQuality(html) {
  const $ = cheerio.load(String(html ?? ''));
  const plainText = $.text();
  const wordsArray = plainText.split(/\s+/).filter(Boolean);
  const words = wordsArray.length;
  const uniqueWords = new Set(wordsArray.map((w) => w.toLowerCase())).size;
  const uniquenessRatio = uniqueWords / Math.max(1, words);
  const headings = countHeadings(html);

  return {
    words,
    uniquenessRatio,
    headings,
    isValid:
      words >= editorialMinWords &&
      uniquenessRatio >= editorialMinUniqueRatio &&
      headings >= editorialMinHeadings,
  };
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

function addEditorialLayer(html, item) {
  const insights = [
    'Desde el contexto economico peruano actual, esto puede influir en decisiones financieras.',
    'Este tipo de movimientos impacta directamente en consumidores y empresas en Peru.',
    'Un punto clave es como esto se refleja en el tipo de cambio local.',
  ];
  const pick = insights[Math.abs(stableHash(item?.id ?? item?.slug ?? item?.title)) % insights.length];
  return `${String(html ?? '').trim()}\n<p><strong>Nota editorial:</strong> ${pick}</p>`;
}

// ---------------------------------------------------------------------------
// Merge analysis + impact (conserva ambos campos separados en el return,
// pero también produce un campo unificado para análisis combinado si se necesita)
// ---------------------------------------------------------------------------
function mergeAnalysisAndImpact(analysisText, impactText) {
  const analysis = sanitizeText(analysisText);
  const impact   = sanitizeText(impactText);
  if (!analysis && !impact) return '';
  if (!analysis) return impact;
  if (!impact)   return analysis;
  if (analysis.toLowerCase().includes(impact.toLowerCase())) return analysis;
  return `${analysis} Impacto en Peru: ${impact}`.trim();
}

// ---------------------------------------------------------------------------
// Validación de impact_text: detecta si el modelo devolvió un texto vacío,
// genérico o placeholder en lugar de contenido real
// ---------------------------------------------------------------------------
const IMPACT_TEXT_GENERIC_PATTERNS = [
  /^impacto\s*(en\s*peru)?[:.]?\s*$/i,
  /^(no\s+aplica|n\/a|pendiente|por\s+definir)$/i,
  /^esta\s+noticia\s+impacta/i,     // demasiado corto/genérico
];

function isImpactTextValid(text) {
  const clean = sanitizeText(text);
  if (clean.length < IMPACT_TEXT_MIN_CHARS) return false;
  return !IMPACT_TEXT_GENERIC_PATTERNS.some((re) => re.test(clean));
}

function isAnalysisTextValid(text) {
  const clean = sanitizeText(text);
  return clean.length >= ANALYSIS_TEXT_MIN_CHARS;
}

// ---------------------------------------------------------------------------
// Schemas JSON para la API
// ---------------------------------------------------------------------------
const DRAFT_QUALITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'score', 'reason'],
  properties: {
    approved: { type: 'boolean' },
    score:    { type: 'number' },
    reason:   { type: 'string' },
  },
};

const SEO_CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['seoTitle', 'seoDescription', 'excerpt', 'tags', 'analysisText'],
  properties: {
    seoTitle:       { type: 'string' },
    seoDescription: { type: 'string' },
    excerpt:        { type: 'string' },
    analysisText:   { type: 'string' },
    tags: {
      type: 'array',
      minItems: 4,
      maxItems: 12,
      items: { type: 'string' },
    },
  },
};

function buildSelectionSchema(allowedIds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['selected', 'discarded', 'summary'],
    properties: {
      selected: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'reason', 'topic', 'score'],
          properties: {
            id:     { type: 'string', enum: allowedIds },
            title:  { type: 'string' },
            reason: { type: 'string' },
            topic:  { type: 'string' },
            score:  { type: 'number' },
          },
        },
      },
      discarded: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'reason', 'topic'],
          properties: {
            id:     { type: 'string', enum: allowedIds },
            title:  { type: 'string' },
            reason: { type: 'string' },
            topic:  { type: 'string' },
          },
        },
      },
      summary: {
        type: 'object',
        additionalProperties: false,
        required: ['focus', 'notes'],
        properties: {
          focus: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  };
}

const REWRITE_AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_valid', 'discard_reason',
    'title', 'slug', 'excerpt', 'body_html',
    'analysis_text', 'impact_text',
    'seo_title', 'seo_description', 'tags',
    'read_time_minutes', 'featured', 'is_published',
    'is_discarded', 'author_name', 'reviewed_by',
  ],
  properties: {
    is_valid:           { type: 'boolean' },
    discard_reason:     { type: 'string' },
    title:              { type: ['string', 'null'] },
    slug:               { type: ['string', 'null'] },
    excerpt:            { type: ['string', 'null'] },
    body_html:          { type: ['string', 'null'] },
    analysis_text:      { type: ['string', 'null'] },
    impact_text:        { type: ['string', 'null'] },
    seo_title:          { type: ['string', 'null'] },
    seo_description:    { type: ['string', 'null'] },
    tags:               { type: ['array', 'null'], items: { type: 'string' } },
    read_time_minutes:  { type: ['number', 'null'] },
    featured:           { type: ['boolean', 'null'] },
    is_published:       { type: ['boolean', 'null'] },
    is_discarded:       { type: ['boolean', 'null'] },
    author_name:        { type: ['string', 'null'] },
    reviewed_by:        { type: ['string', 'null'] },
  },
};

// ---------------------------------------------------------------------------
// Exports de feature flags
// ---------------------------------------------------------------------------
function toBooleanEnv(value, fallback) {
  if (value == null) return fallback;
  const n = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'si', 'on'].includes(n)) return true;
  if (['0', 'false', 'no', 'off'].includes(n)) return false;
  return fallback;
}

export function isAiPipelineEnabled() {
  return toBooleanEnv(process.env.NEWS_AI_ENABLED, true);
}

export function hasOpenAiCredentials() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// ---------------------------------------------------------------------------
// Retry con backoff exponencial + jitter
// ---------------------------------------------------------------------------
async function withRetry(fn, maxRetries = openAiMaxRetries) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const statusCode = Number(error?.statusCode ?? 0);
      const isRetryable = statusCode === 429 || statusCode >= 500 || error?.name === 'AbortError';
      if (!isRetryable || attempt === maxRetries - 1) throw error;
      const exponential = openAiRetryBaseMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * Math.max(100, Math.round(openAiRetryBaseMs * 0.3)));
      const delayMs = Math.min(15000, exponential + jitter);
      console.log(`[ai] Reintentando en ${delayMs}ms (intento ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Extracción del texto de la respuesta de la Responses API
// ---------------------------------------------------------------------------
function extractResponsesText(payload) {
  const outputText = payload?.output?.[0]?.content?.[0]?.text;
  if (typeof outputText === 'string' && outputText.trim()) return outputText;
  const aggregated = payload?.output_text;
  if (typeof aggregated === 'string' && aggregated.trim()) return aggregated;
  return '';
}

// ---------------------------------------------------------------------------
// Cliente JSON de OpenAI Responses API con fallback de formato
// ---------------------------------------------------------------------------
async function openAiJson(userPrompt, systemPrompt, schemaConfig, customTimeoutMs) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  if (!schemaConfig?.name || !schemaConfig?.schema) throw new Error('Missing JSON schema configuration');

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeoutMs ?? timeoutMs);

    try {
      const basePayload = {
        model: DEFAULT_MODEL,
        temperature: 0.2,
        max_output_tokens: openAiMaxOutputTokens,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user',   content: [{ type: 'input_text', text: userPrompt }] },
        ],
      };

      const schemaFormat = {
        type: 'json_schema',
        json_schema: { name: schemaConfig.name, strict: true, schema: schemaConfig.schema },
      };

      const requestHeaders = {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      };

      let response = await fetch(`${OPENAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: requestHeaders,
        signal: controller.signal,
        body: JSON.stringify({ ...basePayload, response_format: schemaFormat }),
      });

      // Fallback: algunos modelos/deployments usan el campo "text.format"
      if (!response.ok) {
        const detail = await response.text();
        if (response.status === 400 && /response_format|json_schema|unknown parameter/i.test(detail)) {
          response = await fetch(`${OPENAI_BASE_URL}/responses`, {
            method: 'POST',
            headers: requestHeaders,
            signal: controller.signal,
            body: JSON.stringify({
              ...basePayload,
              text: { format: { type: 'json_schema', name: schemaConfig.name, strict: true, schema: schemaConfig.schema } },
            }),
          });
        }
        if (!response.ok) {
          const errDetail = await response.text();
          const error = new Error(`OpenAI HTTP ${response.status}: ${errDetail.slice(0, 400)}`);
          error.name = 'OpenAiHttpError';
          error.statusCode = response.status;
          throw error;
        }
      }

      const payload = await response.json();
      const content = extractResponsesText(payload);
      const parsed  = content ? JSON.parse(content) : null;
      if (!parsed || typeof parsed !== 'object') throw new Error('OpenAI response did not contain valid JSON');
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  });
}

// ---------------------------------------------------------------------------
// Compactadores de artículos para enviar menos tokens a la API
// ---------------------------------------------------------------------------
function compactArticle(article) {
  return {
    title:     sanitizeText(article?.title).slice(0, 260),
    excerpt:   sanitizeText(article?.excerpt).slice(0, 400),
    body:      sanitizeText(article?.bodyHtml ?? article?.body_html).slice(0, 3000),
    source:    sanitizeText(article?.sourceName ?? article?.source_name).slice(0, 120),
    sourceUrl: sanitizeText(article?.sourceUrl ?? article?.source_url).slice(0, 400),
  };
}

function compactSelectionArticle(article) {
  return {
    id:      sanitizeText(article?.id).slice(0, 120),
    title:   sanitizeText(article?.title).slice(0, 260),
    excerpt: sanitizeText(article?.excerpt).slice(0, 260),
    source:  sanitizeText(article?.source).slice(0, 120),
    date:    sanitizeText(article?.date).slice(0, 80),
  };
}

// ---------------------------------------------------------------------------
// Resolución de IDs desde la respuesta de selección
// ---------------------------------------------------------------------------
function normalizeTitleKey(value) {
  return sanitizeText(value)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function titleTokens(value) {
  return normalizeTitleKey(value).split(/\s+/).filter((t) => t.length >= 4);
}

function resolveArticleIdByTitleSimilarity(rawTitle, titleToId) {
  const sourceTokens = new Set(titleTokens(rawTitle));
  if (sourceTokens.size === 0) return null;

  let bestId = null, bestScore = 0, bestOverlap = 0;

  for (const [titleKey, id] of titleToId.entries()) {
    const targetTokens = new Set(titleTokens(titleKey));
    if (targetTokens.size === 0) continue;

    let overlap = 0;
    for (const token of sourceTokens) { if (targetTokens.has(token)) overlap++; }
    const union = new Set([...sourceTokens, ...targetTokens]).size;
    const score = overlap / Math.max(1, union);

    if (score > bestScore || (score === bestScore && overlap > bestOverlap)) {
      bestScore = score; bestOverlap = overlap; bestId = id;
    }
  }

  return bestOverlap >= 1 && bestScore >= 0.2 ? bestId : null;
}

function resolveArticleId(item, allowedIds, titleToId) {
  const directId = sanitizeText(item?.id ?? item?.articleId ?? item?.slug);
  if (directId && allowedIds.has(directId)) return directId;

  const byTitle = titleToId.get(normalizeTitleKey(item?.title));
  if (byTitle && allowedIds.has(byTitle)) return byTitle;

  const bySimilarity = resolveArticleIdByTitleSimilarity(item?.title, titleToId);
  if (bySimilarity && allowedIds.has(bySimilarity)) return bySimilarity;

  return null;
}

function normalizeSelectionResult(result, allowedIds, titleToId) {
  const selected = toArray(result?.selected)
    .map((item) => {
      const id = resolveArticleId(item, allowedIds, titleToId);
      if (!id) return null;
      return {
        id,
        title:  sanitizeText(item?.title).slice(0, 260),
        reason: sanitizeText(item?.reason).slice(0, 220),
        topic:  sanitizeText(item?.topic).slice(0, 120),
        score:  clamp(Number(item?.score ?? item?.priority ?? 0), 0, 100),
      };
    })
    .filter(Boolean);

  const uniqueSelected = [];
  const selectedSet = new Set();
  for (const item of selected) {
    if (selectedSet.has(item.id)) continue;
    selectedSet.add(item.id);
    uniqueSelected.push(item);
  }

  const discarded = toArray(result?.discarded)
    .map((item) => {
      const id = resolveArticleId(item, allowedIds, titleToId);
      if (!id || selectedSet.has(id)) return null;
      return {
        id,
        title:  sanitizeText(item?.title).slice(0, 260),
        reason: sanitizeText(item?.reason).slice(0, 220),
        topic:  sanitizeText(item?.topic).slice(0, 120),
      };
    })
    .filter(Boolean);

  return {
    selected: uniqueSelected,
    discarded,
    summary: {
      requested: allowedIds.size,
      selected:  uniqueSelected.length,
      discarded: discarded.length,
      focus:     sanitizeText(result?.summary?.focus).slice(0, 180),
      notes:     sanitizeText(result?.summary?.notes).slice(0, 260),
    },
  };
}

// ---------------------------------------------------------------------------
// validateDraftQuality
// ---------------------------------------------------------------------------
export async function validateDraftQuality(article) {
  const minScore = clamp(Number(process.env.NEWS_AI_MIN_QUALITY_SCORE ?? 70), 40, 95);
  const data = compactArticle(article);

  const systemPrompt = [
    'Eres editor senior de noticias economicas de Peru.',
    'Valida calidad periodistica y utilidad para usuarios que buscan informacion economica, dolar y finanzas en Peru.',
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

  const result = await openAiJson(userPrompt, systemPrompt, {
    name: 'draft_quality_validation',
    schema: DRAFT_QUALITY_SCHEMA,
  });

  const score          = clamp(Number(result.score ?? 0), 0, 100);
  const approvedByModel = Boolean(result.approved);
  const approved        = approvedByModel && score >= minScore;

  return {
    approved,
    score,
    reason:   sanitizeText(result.reason).slice(0, 240) || 'Sin observaciones.',
    minScore,
  };
}

// ---------------------------------------------------------------------------
// generateSeoContent
// ---------------------------------------------------------------------------
export async function generateSeoContent(article) {
  const data = compactArticle(article);

  const systemPrompt = [
    'Eres especialista SEO en medios de economia de Peru.',
    'Responde solo JSON con keys: seoTitle, seoDescription, excerpt, tags, analysisText.',
    'seoTitle max 60 chars; seoDescription max 160 chars; excerpt 130-220 chars.',
    'tags debe ser array de 6 a 10 tags en minusculas y formato slug (sin tildes, sin espacios, usar guion).',
    `analysisText ${ANALYSIS_TEXT_MIN_CHARS}-${ANALYSIS_TEXT_MAX_CHARS} chars con foco util para lector peruano.`,
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Genera campos SEO listos para publicacion automatica.',
    article: data,
  });

  const result = await openAiJson(userPrompt, systemPrompt, {
    name: 'seo_content_generation',
    schema: SEO_CONTENT_SCHEMA,
  });

  const tags = Array.isArray(result.tags)
    ? result.tags.map(normalizeTag).filter(Boolean)
    : [];

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline:      sanitizeText(result.seoTitle).slice(0, 60),
    description:   sanitizeText(result.seoDescription).slice(0, 160),
    datePublished: new Date().toISOString(),
    dateModified:  new Date().toISOString(),
    author:    { '@type': 'Organization', name: 'Equipo Editorial DolarPeruHoy' },
    publisher: {
      '@type': 'Organization',
      name: 'DolarPeruHoy',
      logo: { '@type': 'ImageObject', url: 'https://dolarperuhoy.com/logo.png' },
    },
  };

  return {
    seoTitle:       sanitizeText(result.seoTitle).slice(0, 60),
    seoDescription: sanitizeText(result.seoDescription).slice(0, 160),
    excerpt:        sanitizeText(result.excerpt).slice(0, 220),
    tags:           [...new Set(tags)].slice(0, 10),
    analysisText:   sanitizeText(result.analysisText).slice(0, ANALYSIS_TEXT_MAX_CHARS),
    structuredData,
  };
}

// ---------------------------------------------------------------------------
// selectBestArticles
// ---------------------------------------------------------------------------
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

  const allowedIds     = new Set(compact.map((item) => item.id));
  const allowedIdsList = compact.map((item) => item.id);
  const titleToId      = new Map(compact.map((item) => [normalizeTitleKey(item.title), item.id]));

  const systemPrompt = [
    'Eres editor SEO senior de un portal financiero peruano.',
    'Analiza un lote de noticias RSS y selecciona SOLO las mejores para publicar.',
    'Devuelve SIEMPRE el id exacto de cada articulo usando el campo id recibido en la entrada.',
    'Prioriza noticias economicas relevantes para Peru.',
    'Detecta duplicados SEMANTICOS y elige solo la mejor version.',
    'Selecciona entre 4 y 6 noticias de mayor calidad.',
    'Prioridades altas: dolar, tipo de cambio, BCRP, inflacion, mineria, bancos, AFP, SUNAT, tasas, inversion, exportaciones, empresas, consumo, empleo y economia peruana.',
    'Descarta deportes, farandula, policiales, clima, clickbait y noticias sin impacto economico en Peru.',
    'Evita seleccionar multiples noticias casi iguales.',
    'Prioriza utilidad, claridad, potencial SEO y diversidad tematica.',
    'Responde SOLO JSON valido. Sin markdown. Sin texto adicional.',
    'Formato exacto: {"selected":[{"id":"","title":"","reason":"","topic":"","score":0}],"discarded":[{"id":"","title":"","reason":"","topic":""}],"summary":{"focus":"","notes":""}}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Selecciona las mejores noticias economicas para publicar hoy.',
    constraints: { minSelected: 4, maxSelected: 6, semanticDeduplication: true, strictJson: true, returnExactIds: true },
    articles: compact,
  });

  try {
    const raw        = await openAiJson(userPrompt, systemPrompt, {
      name: 'news_selection',
      schema: buildSelectionSchema(allowedIdsList),
    }, selectionTimeoutMs);  // timeout extendido para batch grande
    const normalized = normalizeSelectionResult(raw, allowedIds, titleToId);

    if (normalized.selected.length === 0) {
      return {
        selected: [],
        discarded: compact.map((item) => ({ id: item.id, reason: 'No seleccionado por IA.' })),
        summary: { requested: compact.length, selected: 0, discarded: compact.length, notes: 'IA no devolvio seleccion util.' },
      };
    }

    return normalized;
  } catch (error) {
    const statusCode = Number(error?.statusCode ?? 0);
    const retryable  = statusCode === 429 || statusCode >= 500;
    return {
      selected: [], discarded: [], failed: true, retryable,
      summary: {
        requested: compact.length, selected: 0, discarded: 0,
        notes: `Error OpenAI: ${sanitizeText(error?.message).slice(0, 240)}`,
        errorCode: statusCode || undefined,
        retryable,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// rewriteAndAuditArticle
// ---------------------------------------------------------------------------
export async function rewriteAndAuditArticle(article) {
  const selectedStructure = pickStructure(article?.id ?? article?.slug ?? article?.title);

  const data = {
    id:      sanitizeText(article?.id ?? article?.slug).slice(0, 100),
    title:   sanitizeText(article?.title).slice(0, 260),
    excerpt: sanitizeText(article?.excerpt).slice(0, 500),
    source:  sanitizeText(article?.source_name ?? article?.source).slice(0, 120),
    date:    sanitizeText(article?.source_published_at ?? article?.date).slice(0, 80),
    html:    String(article?.body_html ?? article?.bodyHtml ?? '').slice(0, 12000),
  };

  const systemPrompt = [
    'Eres periodista económico peruano con 15 años de experiencia en medios como Gestión y El Comercio.',
    'Tu escritura es directa, clara y útil para el lector común, no para académicos.',
    'Escribes como un humano que conoce bien el día a día económico del peruano: el precio del dólar en el banco, la cuota del crédito, el costo de la canasta básica.',

    // VALIDACIÓN — breve, sin burocracia
    'PASO 1 - DECIDE: ¿Vale la pena publicar esto para un peruano que busca información económica práctica?',
    'Descarta si es: deportes, farándula, política sin impacto económico, noticia internacional sin efecto en Perú, contenido menor a 3 párrafos útiles.',
    'NUNCA descartes noticias sobre dólar, tipo de cambio, inflación, BCRP, AFP, SUNAT, bancos o precios aunque sean cortas — amplíalas tú.',

    // REESCRITURA — estilo humano
    'PASO 2 - REESCRIBE con estas reglas de estilo OBLIGATORIAS:',
    '1. Primera oración: dato concreto o hecho, nunca una frase genérica. Ejemplo MALO: "La economía peruana enfrenta desafíos". Ejemplo BUENO: "El dólar cerró esta semana en S/3.46, su nivel más bajo en dos meses."',
    '2. Subtítulos H2/H3: descriptivos y directos, nunca vagos. MALO: "Análisis de la situación". BUENO: "Por qué el BCRP intervino esta semana".',
    '3. Prohibido usar estas frases: "en el contexto actual", "cabe destacar", "es importante mencionar", "en ese sentido", "en resumen", "en conclusión", "vale la pena señalar", "resulta fundamental", "es crucial", "juega un papel fundamental".',
    '4. Cada párrafo debe tener UNA idea y máximo 4 oraciones. Sin párrafos relleno.',
    '5. Usa cifras y ejemplos concretos cuando los haya en la fuente. Si no hay, usa comparaciones que el peruano entienda.',
    '6. El tono es periodístico informativo, no académico ni corporativo.',
    '7. Varía la longitud de las oraciones: mezcla oraciones cortas con otras más largas para que fluya natural.',

    // CAMPOS ESPECIALES
    `analysis_text: 2-3 oraciones explicando por qué esta noticia le importa al peruano de a pie. Empieza directo, sin "Este artículo analiza" ni frases similares.`,
    `impact_text: 2-3 oraciones sobre el efecto concreto en Perú: precios, empleo, tipo de cambio o bolsillo del consumidor. Si es noticia internacional, explica la conexión real con Perú en una oración. Sin frases genéricas.`,

    // ESTRUCTURA y FORMATO
    `Organiza el artículo en este orden: ${selectedStructure.join(' → ')}.`,
    `Mínimo ${editorialMinWords} palabras en body_html. Mínimo ${editorialMinHeadings} subtítulos H2 o H3.`,
    'Solo HTML permitido: <p>, <h2>, <h3>, <ul>, <li>, <strong>. Sin iframes, scripts ni publicidad.',

    // SALIDA
    'Devuelve ÚNICAMENTE JSON válido. Sin markdown, sin explicaciones fuera del JSON.',
    'Si es apta: {"is_valid":true,"discard_reason":"","title":"","slug":"","excerpt":"","body_html":"","analysis_text":"","impact_text":"","seo_title":"","seo_description":"","tags":[""],"read_time_minutes":3,"featured":false,"is_published":true,"is_discarded":false,"author_name":"Equipo DolarPeruHoy","reviewed_by":"Equipo Editorial DolarPeruHoy"}',
    'Si NO es apta: {"is_valid":false,"discard_reason":"motivo concreto en una línea"}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Reescribe este artículo como lo haría un periodista económico peruano experimentado. Útil, directo, sin relleno.',
    input: data,
    estructura: selectedStructure,
    recordatorios_estilo: [
      'Primera oración = dato concreto, no frase genérica',
      'Subtítulos descriptivos y específicos',
      'Prohibido: "en el contexto actual", "cabe destacar", "es importante mencionar", "en resumen", "juega un papel fundamental"',
      'Párrafos cortos, una idea por párrafo',
      'analysis_text e impact_text: concretos, sin frases de relleno, mínimo 2 oraciones cada uno',
    ],
    limites: {
      minPalabras: editorialMinWords,
      excerptChars: '140-220',
      seoTitleChars: 'máx 70',
      seoDescriptionChars: 'máx 160',
      tituloChars: 'máx 90',
    },
  });

  const raw = await openAiJson(userPrompt, systemPrompt, {
    name: 'rewrite_and_audit',
    schema: REWRITE_AUDIT_SCHEMA,
  });

  // Artículo rechazado por el modelo
  if (!raw?.is_valid) {
    return {
      isValid: false,
      discardReason: sanitizeText(raw?.discard_reason).slice(0, 240) || 'No apta editorialmente.',
    };
  }

  // Validación de calidad editorial del body_html
  const quality = validateEditorialQuality(raw?.body_html ?? '');
  if (quality.words < editorialMinWords) {
    return { isValid: false, discardReason: `Contenido muy corto (< ${editorialMinWords} palabras).` };
  }
  if (quality.uniquenessRatio < editorialMinUniqueRatio) {
    return { isValid: false, discardReason: `Baja unicidad de contenido (< ${editorialMinUniqueRatio}). Potencial relleno.` };
  }
  if (quality.headings < editorialMinHeadings) {
    return { isValid: false, discardReason: `Sin estructura de subtitulos (< ${editorialMinHeadings} H2/H3).` };
  }

  // Post-procesado de campos
  const tags           = toArray(raw?.tags).map(normalizeTag).filter(Boolean).slice(0, 8);
  const title          = sanitizeText(raw?.title).slice(0, 90);
  const seoTitle       = sanitizeText(raw?.seo_title).slice(0, 70);
  const seoDescription = sanitizeText(raw?.seo_description).slice(0, 160);
  const excerpt        = sanitizeText(raw?.excerpt).slice(0, 220);
  const bodyHtml       = addEditorialLayer(raw?.body_html ?? '', data);
  const metrics        = calculateContentMetrics(bodyHtml);

  // impact_text: usar el valor del modelo si es válido, o loguear advertencia
  const rawImpactText   = sanitizeText(raw?.impact_text);
  const rawAnalysisText = sanitizeText(raw?.analysis_text);

  if (!isImpactTextValid(rawImpactText)) {
    console.warn(`[ai] impact_text insuficiente o generico para "${title.slice(0, 60)}". Longitud: ${rawImpactText.length}`);
  }
  if (!isAnalysisTextValid(rawAnalysisText)) {
    console.warn(`[ai] analysis_text insuficiente para "${title.slice(0, 60)}". Longitud: ${rawAnalysisText.length}`);
  }

  // impactText se devuelve siempre (el fallback lo pone scraper.js desde buildImpactText)
  const impactText  = rawImpactText.slice(0, IMPACT_TEXT_MAX_CHARS);
  const analysisText = rawAnalysisText.slice(0, ANALYSIS_TEXT_MAX_CHARS);

  // mergedAnalysisText: campo combinado para contextos que quieran un solo texto
  const mergedAnalysisText = mergeAnalysisAndImpact(analysisText, impactText)
    .slice(0, ANALYSIS_TEXT_MAX_CHARS + IMPACT_TEXT_MAX_CHARS);

  return {
    isValid: true,
    discardReason: '',
    title:        title || data.title,
    slug:         slugify(raw?.slug || title || data.title).slice(0, 120) || data.id || 'noticia-economia',
    excerpt:      excerpt || data.excerpt,
    bodyHtml,
    // Campos separados — scraper.js los usa individualmente
    analysisText,
    impactText,
    // Campo combinado para referencias opcionales
    mergedAnalysisText,
    seoTitle:     seoTitle || title || data.title,
    seoDescription: seoDescription || data.excerpt,
    tags:         [...new Set(tags)],
    readTimeMinutes: Math.max(3, Number(raw?.read_time_minutes) || 3),
    featured:     Boolean(raw?.featured),
    isPublished:  false,
    isDiscarded:  Boolean(raw?.is_discarded),
    authorName:   sanitizeText(raw?.author_name) || 'Equipo Editorial DolarPeruHoy',
    reviewedBy:   sanitizeText(raw?.reviewed_by) || 'Equipo Editorial DolarPeruHoy',
    contentMetrics: metrics,
  };
}