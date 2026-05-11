import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Modelos separados por tarea
// ---------------------------------------------------------------------------
const SELECTION_MODEL = process.env.OPENAI_SELECTION_MODEL ?? 'gpt-4.1-mini';
const REWRITE_MODEL   = process.env.OPENAI_REWRITE_MODEL   ?? 'gpt-4.1';
const DEFAULT_MODEL   = process.env.OPENAI_MODEL           ?? 'gpt-4.1-mini';

const OPENAI_BASE_URL     = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const timeoutMs           = Number(process.env.OPENAI_TIMEOUT_MS            ?? 45000);
const selectionTimeoutMs  = Number(process.env.OPENAI_SELECTION_TIMEOUT_MS  ?? timeoutMs * 2);
const rewriteTimeoutMs    = Number(process.env.OPENAI_REWRITE_TIMEOUT_MS    ?? timeoutMs * 1.5);

const editorialMinWords       = clamp(Number(process.env.NEWS_EDITORIAL_MIN_WORDS             ?? 280), 200, 900);
const editorialMinUniqueRatio = clamp(Number(process.env.NEWS_EDITORIAL_MIN_UNIQUENESS_RATIO  ?? 0.38), 0.25, 0.7);
const editorialMinHeadings    = clamp(Number(process.env.NEWS_EDITORIAL_MIN_HEADINGS          ?? 2), 1, 4);
const openAiMaxRetries        = clamp(Number(process.env.OPENAI_MAX_RETRIES                   ?? 2), 1, 5);
const openAiRetryBaseMs       = clamp(Number(process.env.OPENAI_RETRY_BASE_MS                 ?? 1000), 100, 5000);
const openAiMaxOutputTokens   = clamp(Number(process.env.OPENAI_MAX_OUTPUT_TOKENS             ?? 4000), 400, 6000);

const IMPACT_TEXT_MIN_CHARS   = clamp(Number(process.env.NEWS_IMPACT_TEXT_MIN_CHARS   ?? 420),  80, 600);
const IMPACT_TEXT_MAX_CHARS   = clamp(Number(process.env.NEWS_IMPACT_TEXT_MAX_CHARS   ?? 800), 200, 1200);
const ANALYSIS_TEXT_MIN_CHARS = clamp(Number(process.env.NEWS_ANALYSIS_TEXT_MIN_CHARS ?? 180),  80, 600);
const ANALYSIS_TEXT_MAX_CHARS = clamp(Number(process.env.NEWS_ANALYSIS_TEXT_MAX_CHARS ?? 520), 200, 1000);

const ARTICLE_STRUCTURES = [
  ['contexto', 'impacto_peru', 'analisis_economico'],
  ['que_ocurrio', 'analisis', 'consecuencias'],
  ['resumen', 'impacto', 'perspectiva_futura'],
];

const WRITING_STYLES = [
  {
    name: 'directo',
    instruction: 'Estilo periodístico directo. Primera oración = el hecho principal con número o dato. Oraciones cortas. Sin introducción larga. Como nota de agencia.',
    closingStyle: 'Cierra con una oración práctica: qué debe hacer o monitorear el lector esta semana.',
  },
  {
    name: 'contextual',
    instruction: 'Estilo explicativo. Empieza situando el hecho en su contexto económico inmediato. Conecta el dato con algo que el lector ya conoce (precio del pan, cuota del banco, sueldo mínimo).',
    closingStyle: 'Cierra con la pregunta que los economistas aún no pueden responder, sin inventar respuesta.',
  },
  {
    name: 'analitico',
    instruction: 'Estilo analítico pero accesible. Explica el mecanismo detrás del dato. Usa analogías simples. Como si se lo explicaras a un amigo que trabaja en una empresa.',
    closingStyle: 'Cierra con lo que hay que seguir de cerca en los próximos días o semanas.',
  },
];

// ---------------------------------------------------------------------------
// Helpers básicos
// ---------------------------------------------------------------------------
function sanitizeText(text) {
  return String(text ?? '').replaceAll(/<[^>]*>/g, ' ').replaceAll(/\s+/g, ' ').trim();
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function toArray(value) { return Array.isArray(value) ? value : []; }

function stableHash(input) {
  let hash = 0;
  const value = String(input ?? '');
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + (value.codePointAt(i) ?? 0)) | 0;
  return hash;
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toLowerCase()
    .replaceAll(/(\d)[.,](\d)/g, '$1-$2').replaceAll(/[^a-z0-9\s-]/g, ' ')
    .replaceAll(/\s+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '');
}

function normalizeTag(tag) {
  return sanitizeText(tag).normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, ' ').replaceAll(/\s+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '');
}

function pickStructure(seed) { return ARTICLE_STRUCTURES[Math.abs(stableHash(seed)) % ARTICLE_STRUCTURES.length]; }
function pickWritingStyle(seed) { return WRITING_STYLES[Math.abs(stableHash(seed)) % WRITING_STYLES.length]; }

// ---------------------------------------------------------------------------
// Validación editorial
// ---------------------------------------------------------------------------
function countHeadings(html) { return cheerio.load(String(html ?? ''))('h2, h3').length; }

function validateEditorialQuality(html) {
  const $ = cheerio.load(String(html ?? ''));
  const words = $.text().split(/\s+/).filter(Boolean);
  const unique = new Set(words.map(w => w.toLowerCase())).size;
  return {
    words: words.length,
    uniquenessRatio: unique / Math.max(1, words.length),
    headings: countHeadings(html),
    isValid: words.length >= editorialMinWords &&
             unique / Math.max(1, words.length) >= editorialMinUniqueRatio &&
             countHeadings(html) >= editorialMinHeadings,
  };
}

function calculateContentMetrics(html) {
  const q = validateEditorialQuality(html);
  return { totalWords: q.words, uniqueWords: Math.round(q.uniquenessRatio * q.words), uniqueRatio: q.uniquenessRatio, headings: q.headings, hasSubheadings: q.headings >= 2, isValid: q.isValid };
}

// Sin nota editorial fija — huella de automatización detectable
function addEditorialLayer(html, _item) { return String(html ?? '').trim(); }

function mergeAnalysisAndImpact(a, b) {
  const analysis = sanitizeText(a), impact = sanitizeText(b);
  if (!analysis && !impact) return '';
  if (!analysis) return impact;
  if (!impact) return analysis;
  if (analysis.toLowerCase().includes(impact.toLowerCase())) return analysis;
  return `${analysis} Impacto en Peru: ${impact}`.trim();
}

const IMPACT_GENERIC = [
  /^impacto\s*(en\s*peru)?[:.]?\s*$/i,
  /^(no\s+aplica|n\/a|pendiente|por\s+definir)$/i,
  /^esta\s+noticia\s+impacta/i,
];

function isImpactTextValid(text) {
  const c = sanitizeText(text);
  return c.length >= IMPACT_TEXT_MIN_CHARS && !IMPACT_GENERIC.some(re => re.test(c));
}
function isAnalysisTextValid(text) { return sanitizeText(text).length >= ANALYSIS_TEXT_MIN_CHARS; }

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const DRAFT_QUALITY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['approved', 'score', 'reason'],
  properties: { approved: { type: 'boolean' }, score: { type: 'number' }, reason: { type: 'string' } },
};

const SEO_CONTENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['seoTitle', 'seoDescription', 'excerpt', 'tags', 'analysisText'],
  properties: {
    seoTitle: { type: 'string' }, seoDescription: { type: 'string' },
    excerpt: { type: 'string' }, analysisText: { type: 'string' },
    tags: { type: 'array', minItems: 4, maxItems: 12, items: { type: 'string' } },
  },
};

function buildSelectionSchema(allowedIds) {
  return {
    type: 'object', additionalProperties: false, required: ['selected', 'discarded', 'summary'],
    properties: {
      selected: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'reason', 'topic', 'score'], properties: { id: { type: 'string', enum: allowedIds }, title: { type: 'string' }, reason: { type: 'string' }, topic: { type: 'string' }, score: { type: 'number' } } } },
      discarded: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'reason', 'topic'], properties: { id: { type: 'string', enum: allowedIds }, title: { type: 'string' }, reason: { type: 'string' }, topic: { type: 'string' } } } },
      summary: { type: 'object', additionalProperties: false, required: ['focus', 'notes'], properties: { focus: { type: 'string' }, notes: { type: 'string' } } },
    },
  };
}

const REWRITE_AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_valid', 'discard_reason', 'title', 'slug', 'excerpt', 'body_html', 'analysis_text', 'impact_text', 'seo_title', 'seo_description', 'tags', 'read_time_minutes', 'featured', 'is_published', 'is_discarded', 'author_name', 'reviewed_by'],
  properties: {
    is_valid: { type: 'boolean' }, discard_reason: { type: 'string' },
    title: { type: ['string', 'null'] }, slug: { type: ['string', 'null'] },
    excerpt: { type: ['string', 'null'] }, body_html: { type: ['string', 'null'] },
    analysis_text: { type: ['string', 'null'] }, impact_text: { type: ['string', 'null'] },
    seo_title: { type: ['string', 'null'] }, seo_description: { type: ['string', 'null'] },
    tags: { type: ['array', 'null'], items: { type: 'string' } },
    read_time_minutes: { type: ['number', 'null'] }, featured: { type: ['boolean', 'null'] },
    is_published: { type: ['boolean', 'null'] }, is_discarded: { type: ['boolean', 'null'] },
    author_name: { type: ['string', 'null'] }, reviewed_by: { type: ['string', 'null'] },
  },
};

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------
function toBooleanEnv(value, fallback) {
  if (value == null) return fallback;
  const n = String(value).trim().toLowerCase();
  if (['1','true','yes','si','on'].includes(n)) return true;
  if (['0','false','no','off'].includes(n)) return false;
  return fallback;
}
export function isAiPipelineEnabled() { return toBooleanEnv(process.env.NEWS_AI_ENABLED, true); }
export function hasOpenAiCredentials() { return Boolean(process.env.OPENAI_API_KEY); }

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------
async function withRetry(fn, maxRetries = openAiMaxRetries) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      const sc = Number(error?.statusCode ?? 0);
      if (!(sc === 429 || sc >= 500 || error?.name === 'AbortError') || attempt === maxRetries - 1) throw error;
      const delay = Math.min(15000, openAiRetryBaseMs * 2 ** attempt + Math.floor(Math.random() * openAiRetryBaseMs * 0.3));
      console.log(`[ai] Reintentando en ${delay}ms (intento ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function extractResponsesText(payload) {
  const t = payload?.output?.[0]?.content?.[0]?.text;
  if (typeof t === 'string' && t.trim()) return t;
  const a = payload?.output_text;
  if (typeof a === 'string' && a.trim()) return a;
  return '';
}

// ---------------------------------------------------------------------------
// Cliente OpenAI — modelo y timeout por llamada
// ---------------------------------------------------------------------------
async function openAiJson(userPrompt, systemPrompt, schemaConfig, customTimeoutMs, model) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  if (!schemaConfig?.name || !schemaConfig?.schema) throw new Error('Missing JSON schema configuration');

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeoutMs ?? timeoutMs);
    try {
      const basePayload = {
        model: model ?? DEFAULT_MODEL,
        temperature: 0.2,
        max_output_tokens: openAiMaxOutputTokens,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user',   content: [{ type: 'input_text', text: userPrompt }] },
        ],
      };
      const schemaFormat = { type: 'json_schema', json_schema: { name: schemaConfig.name, strict: true, schema: schemaConfig.schema } };
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

      let response = await fetch(`${OPENAI_BASE_URL}/responses`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ ...basePayload, response_format: schemaFormat }) });

      if (!response.ok) {
        const detail = await response.text();
        if (response.status === 400 && /response_format|json_schema|unknown parameter/i.test(detail)) {
          response = await fetch(`${OPENAI_BASE_URL}/responses`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ ...basePayload, text: { format: { type: 'json_schema', name: schemaConfig.name, strict: true, schema: schemaConfig.schema } } }) });
        }
        if (!response.ok) {
          const err = new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
          err.name = 'OpenAiHttpError'; err.statusCode = response.status; throw err;
        }
      }

      const payload = await response.json();
      const content = extractResponsesText(payload);
      const parsed  = content ? JSON.parse(content) : null;
      if (!parsed || typeof parsed !== 'object') throw new Error('OpenAI response did not contain valid JSON');
      return parsed;
    } finally { clearTimeout(timeout); }
  });
}

// ---------------------------------------------------------------------------
// Compactadores
// ---------------------------------------------------------------------------
function compactArticle(a) {
  return { title: sanitizeText(a?.title).slice(0,260), excerpt: sanitizeText(a?.excerpt).slice(0,400), body: sanitizeText(a?.bodyHtml ?? a?.body_html).slice(0,3000), source: sanitizeText(a?.sourceName ?? a?.source_name).slice(0,120), sourceUrl: sanitizeText(a?.sourceUrl ?? a?.source_url).slice(0,400) };
}
function compactSelectionArticle(a) {
  return { id: sanitizeText(a?.id).slice(0,120), title: sanitizeText(a?.title).slice(0,260), excerpt: sanitizeText(a?.excerpt).slice(0,260), source: sanitizeText(a?.source).slice(0,120), date: sanitizeText(a?.date).slice(0,80) };
}

// ---------------------------------------------------------------------------
// Resolución de IDs
// ---------------------------------------------------------------------------
function normalizeTitleKey(v) {
  return sanitizeText(v).normalize('NFD').replaceAll(/[\u0300-\u036f]/g,'').toLowerCase().replaceAll(/[^a-z0-9\s]/g,' ').replaceAll(/\s+/g,' ').trim();
}
function titleTokens(v) { return normalizeTitleKey(v).split(/\s+/).filter(t => t.length >= 4); }

function resolveArticleIdByTitleSimilarity(rawTitle, titleToId) {
  const src = new Set(titleTokens(rawTitle));
  if (!src.size) return null;
  let bestId = null, bestScore = 0, bestOverlap = 0;
  for (const [k, id] of titleToId) {
    const tgt = new Set(titleTokens(k));
    if (!tgt.size) continue;
    let overlap = 0;
    for (const t of src) if (tgt.has(t)) overlap++;
    const score = overlap / Math.max(1, new Set([...src,...tgt]).size);
    if (score > bestScore || (score === bestScore && overlap > bestOverlap)) { bestScore = score; bestOverlap = overlap; bestId = id; }
  }
  return bestOverlap >= 1 && bestScore >= 0.2 ? bestId : null;
}

function resolveArticleId(item, allowedIds, titleToId) {
  const d = sanitizeText(item?.id ?? item?.articleId ?? item?.slug);
  if (d && allowedIds.has(d)) return d;
  const t = titleToId.get(normalizeTitleKey(item?.title));
  if (t && allowedIds.has(t)) return t;
  const s = resolveArticleIdByTitleSimilarity(item?.title, titleToId);
  return (s && allowedIds.has(s)) ? s : null;
}

function normalizeSelectionResult(result, allowedIds, titleToId) {
  const selected = toArray(result?.selected).map(item => {
    const id = resolveArticleId(item, allowedIds, titleToId);
    if (!id) return null;
    return { id, title: sanitizeText(item?.title).slice(0,260), reason: sanitizeText(item?.reason).slice(0,220), topic: sanitizeText(item?.topic).slice(0,120), score: clamp(Number(item?.score ?? 0), 0, 100) };
  }).filter(Boolean);

  const uniqueSelected = [], selectedSet = new Set();
  for (const item of selected) { if (selectedSet.has(item.id)) continue; selectedSet.add(item.id); uniqueSelected.push(item); }

  const discarded = toArray(result?.discarded).map(item => {
    const id = resolveArticleId(item, allowedIds, titleToId);
    if (!id || selectedSet.has(id)) return null;
    return { id, title: sanitizeText(item?.title).slice(0,260), reason: sanitizeText(item?.reason).slice(0,220), topic: sanitizeText(item?.topic).slice(0,120) };
  }).filter(Boolean);

  return { selected: uniqueSelected, discarded, summary: { requested: allowedIds.size, selected: uniqueSelected.length, discarded: discarded.length, focus: sanitizeText(result?.summary?.focus).slice(0,180), notes: sanitizeText(result?.summary?.notes).slice(0,260) } };
}

// ---------------------------------------------------------------------------
// validateDraftQuality
// ---------------------------------------------------------------------------
export async function validateDraftQuality(article) {
  const minScore = clamp(Number(process.env.NEWS_AI_MIN_QUALITY_SCORE ?? 70), 40, 95);
  const result = await openAiJson(
    JSON.stringify({ instruction: 'Evalua si vale publicar este borrador como noticia economica util en Peru.', acceptanceCriteria: ['relevancia economica para Peru','claridad del titular y resumen','suficiente contenido informativo y no clickbait','sin contenido claramente irrelevante'], minScore, article: compactArticle(article) }),
    'Eres editor senior de noticias economicas de Peru. Valida calidad periodistica. Responde estrictamente JSON con keys: approved(boolean), score(number 0-100), reason(string corta).',
    { name: 'draft_quality_validation', schema: DRAFT_QUALITY_SCHEMA }
  );
  const score = clamp(Number(result.score ?? 0), 0, 100);
  return { approved: Boolean(result.approved) && score >= minScore, score, reason: sanitizeText(result.reason).slice(0,240) || 'Sin observaciones.', minScore };
}

// ---------------------------------------------------------------------------
// generateSeoContent
// ---------------------------------------------------------------------------
export async function generateSeoContent(article) {
  const result = await openAiJson(
    JSON.stringify({ instruction: 'Genera campos SEO listos para publicacion automatica.', article: compactArticle(article) }),
    [`Eres especialista SEO en medios de economia de Peru.`, `Responde solo JSON: seoTitle (máx 60), seoDescription (máx 160), excerpt (130-220), tags (6-10 slugs), analysisText (${ANALYSIS_TEXT_MIN_CHARS}-${ANALYSIS_TEXT_MAX_CHARS} chars).`].join(' '),
    { name: 'seo_content_generation', schema: SEO_CONTENT_SCHEMA }
  );
  const tags = Array.isArray(result.tags) ? result.tags.map(normalizeTag).filter(Boolean) : [];
  return {
    seoTitle: sanitizeText(result.seoTitle).slice(0,60),
    seoDescription: sanitizeText(result.seoDescription).slice(0,160),
    excerpt: sanitizeText(result.excerpt).slice(0,220),
    tags: [...new Set(tags)].slice(0,10),
    analysisText: sanitizeText(result.analysisText).slice(0,ANALYSIS_TEXT_MAX_CHARS),
    structuredData: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: sanitizeText(result.seoTitle).slice(0,60), description: sanitizeText(result.seoDescription).slice(0,160), datePublished: new Date().toISOString(), dateModified: new Date().toISOString(), author: { '@type': 'Organization', name: 'Equipo Editorial DolarPeruHoy' }, publisher: { '@type': 'Organization', name: 'DolarPeruHoy', logo: { '@type': 'ImageObject', url: 'https://dolarperuhoy.com/logo.png' } } },
  };
}

// ---------------------------------------------------------------------------
// selectBestArticles — gpt-4.1-mini (clasificación, no necesita modelo potente)
// ---------------------------------------------------------------------------
export async function selectBestArticles(articles) {
  const compact = toArray(articles).map(compactSelectionArticle).filter(i => i.id && i.title);
  if (!compact.length) return { selected: [], discarded: [], summary: { requested: 0, selected: 0, discarded: 0, notes: 'Sin articulos elegibles.' } };

  const allowedIds = new Set(compact.map(i => i.id));
  const allowedIdsList = compact.map(i => i.id);
  const titleToId = new Map(compact.map(i => [normalizeTitleKey(i.title), i.id]));

  const systemPrompt = [
    'Eres editor SEO senior de un portal financiero peruano.',
    'Selecciona entre 4 y 6 noticias de mayor calidad e impacto económico para Perú.',
    'Devuelve SIEMPRE el id exacto usando el campo id recibido.',
    'Prioridades: inflacion, BCRP, mineria, bancos, AFP, SUNAT, exportaciones, empleo, dolar.',
    'REGLA CRITICA — LIMITE DOLAR: Maximo 2 noticias sobre dolar/tipo de cambio en todo el lote. Si hay mas de 2, conserva la mas completa (preferiblemente el cierre del dia con datos concretos) y descarta las demas como duplicados semanticos.',
    'REGLA CRITICA — DIVERSIDAD: No puedes seleccionar 2 noticias del mismo tema. Una sobre apertura del dolar y otra sobre cierre del dolar ES el mismo tema — elige solo una.',
    'Descarta: deportes, farandula, policiales, clima, clickbait, internacional sin impacto Peru.',
    'Descarta noticias de vuelos, aeropuertos, transporte o logistica a MENOS que mencionen explicitamente un costo concreto, tarifa o impacto en precios para Peru (ej. "los fletes suben 12%").',
    'Prioriza diversidad tematica: un articulo por tema. Si tienes dolar, inflacion, empleo, exportaciones — selecciona uno de cada uno.',
    'Responde SOLO JSON valido. Sin markdown.',
  ].join(' ');

  try {
    const raw = await openAiJson(
      JSON.stringify({ instruction: 'Selecciona las mejores noticias economicas para publicar hoy.', constraints: { minSelected: 4, maxSelected: 6, maxDollarTipoCambioArticles: 2, semanticDeduplication: true, diversidadTematicaObligatoria: true, returnExactIds: true }, articles: compact }),
      systemPrompt,
      { name: 'news_selection', schema: buildSelectionSchema(allowedIdsList) },
      selectionTimeoutMs,
      SELECTION_MODEL
    );
    const normalized = normalizeSelectionResult(raw, allowedIds, titleToId);
    if (!normalized.selected.length) {
      return { selected: [], discarded: compact.map(i => ({ id: i.id, reason: 'No seleccionado por IA.' })), summary: { requested: compact.length, selected: 0, discarded: compact.length, notes: 'IA no devolvio seleccion util.' } };
    }
    return normalized;
  } catch (error) {
    const sc = Number(error?.statusCode ?? 0);
    return { selected: [], discarded: [], failed: true, retryable: sc === 429 || sc >= 500 || error?.name === 'AbortError', summary: { requested: compact.length, selected: 0, discarded: 0, notes: `Error OpenAI: ${sanitizeText(error?.message).slice(0,240)}`, errorCode: sc || undefined } };
  }
}

// ---------------------------------------------------------------------------
// rewriteAndAuditArticle — gpt-4.1 (reescritura editorial compleja)
// ---------------------------------------------------------------------------
export async function rewriteAndAuditArticle(article) {
  const selectedStructure = pickStructure(article?.id ?? article?.slug ?? article?.title);
  const writingStyle = pickWritingStyle((article?.slug ?? article?.title ?? '') + '_style');

  const data = {
    id:      sanitizeText(article?.id ?? article?.slug).slice(0, 100),
    title:   sanitizeText(article?.title).slice(0, 260),
    excerpt: sanitizeText(article?.excerpt).slice(0, 500),
    source:  sanitizeText(article?.source_name ?? article?.source).slice(0, 120),
    date:    sanitizeText(article?.source_published_at ?? article?.date).slice(0, 80),
    html:    String(article?.body_html ?? article?.bodyHtml ?? '').slice(0, 12000),
  };

  const systemPrompt = [
    'Eres periodista económico peruano con 15 años de experiencia en Gestión y El Comercio.',
    'Escribes directo, claro y útil para el lector común: el precio del dólar en el banco, la cuota del crédito, la canasta básica.',

    'PASO 1: ¿Vale publicar esto para un peruano que busca información económica práctica?',
    'Descarta: deportes, farándula, política sin impacto económico, internacional sin efecto en Perú, menos de 3 párrafos útiles.',
    'NUNCA descartes: dólar, tipo de cambio, inflación, BCRP, AFP, SUNAT, bancos, precios — amplíalas si son cortas.',

    `ESTILO: ${writingStyle.instruction}`,
    `CIERRE: ${writingStyle.closingStyle}`,

    'PASO 2 — REGLAS OBLIGATORIAS:',
    '1. Primera oración: dato concreto. MALO: "La economía enfrenta desafíos". BUENO: "El dólar cerró en S/3.46, mínimo de dos meses."',
    '2. H2/H3 descriptivos. MALO: "Análisis". BUENO: "Por qué el BCRP intervino esta semana".',
    '3. PROHIBIDO: "en el contexto actual", "cabe destacar", "es importante mencionar", "en ese sentido", "en resumen", "en conclusión", "vale la pena señalar", "resulta fundamental", "es crucial", "juega un papel fundamental".',
    '4. Párrafo = 1 idea, máx 4 oraciones.',
    '5. Cifras concretas de la fuente. Si no hay, usa comparaciones que el peruano entienda.',
    '6. Tono periodístico, no académico.',
    '7. Mezcla oraciones cortas y largas para que fluya natural.',
    'CAMPO featured: pon true SOLO si esta noticia es el hecho económico más importante del día: inversión estructural mayor (>US$100M), cambio de política del BCRP/SUNAT/AFP, crisis o reforma que afecta a millones. Las noticias diarias de apertura/cierre del dólar NO son featured. Ejemplos de featured=true: "Glencore triplicará producción de cobre", "BCRP sube tasa de referencia", "Chancay zona económica sin impuestos". Ejemplos de featured=false: "Dólar baja a S/3.45 este viernes".',

    'analysis_text: 2-3 oraciones directas sobre por qué importa al peruano. Sin "Este artículo analiza".',

    'impact_text — EL CAMPO MÁS IMPORTANTE. Escribe 3-5 oraciones con impacto CONCRETO:',
    '  a) Efecto en el bolsillo: qué sube/baja, cuánto, para quién.',
    '  b) Sector específico: importadores, exportadores, deudores en dólares, ahorristas, AFP, pymes.',
    '  c) Acción práctica: revisar deuda, esperar para cambiar dólares, comparar tasas.',
    'MALO: "El tipo de cambio impacta la economía afectando precios."',
    'BUENO: "Con el dólar en S/3.46, quienes tienen hipotecas en dólares pagan S/17 menos por cada USD 100 vs. cuando estaba en S/3.65. Para importadores de electrodomésticos, el margen mejora. Si tienes dólares ahorrados, esta semana no es el mejor momento para venderlos."',
    `Mínimo 80 palabras en impact_text. Para dólar/tipo de cambio: 100 palabras.`,

    `Estructura: ${selectedStructure.join(' → ')}.`,
    `Mínimo ${editorialMinWords} palabras en body_html. Mínimo ${editorialMinHeadings} H2/H3.`,
    'Solo HTML: <p>, <h2>, <h3>, <ul>, <li>, <strong>. Sin iframes ni scripts.',
    'Devuelve ÚNICAMENTE JSON válido. Sin markdown.',
    'Apta: {"is_valid":true,"discard_reason":"","title":"","slug":"","excerpt":"","body_html":"","analysis_text":"","impact_text":"","seo_title":"","seo_description":"","tags":[""],"read_time_minutes":3,"featured":false,"is_published":true,"is_discarded":false,"author_name":"Equipo DolarPeruHoy","reviewed_by":"Equipo Editorial DolarPeruHoy"}',
    'No apta: {"is_valid":false,"discard_reason":"motivo en una línea"}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    instruction: 'Reescribe como periodista económico peruano. Útil, directo, sin relleno.',
    input: data,
    estructura: selectedStructure,
    recordatorios: [
      'Primera oración = dato concreto',
      'H2/H3 descriptivos y específicos',
      'PROHIBIDO: "en el contexto actual", "cabe destacar", "en resumen", "juega un papel fundamental"',
      'impact_text: mínimo 80 palabras, (a) bolsillo con cifra, (b) sector específico, (c) acción práctica',
      'analysis_text: 2-3 oraciones, empieza con el hecho',
    ],
    limites: {
      minPalabrasBodyHtml: editorialMinWords,
      minCharsTextoPlano: Math.round(editorialMinWords * 6.5),
      excerptChars: '140-220', seoTitleChars: 'máx 70', seoDescriptionChars: 'máx 160', tituloChars: 'máx 90',
      advertencia: `body_html mínimo ${editorialMinWords} palabras. Si la fuente es corta, amplía con contexto peruano (historia del indicador, comparación meses anteriores, impacto en consumidor).`,
    },
  });

  const raw = await openAiJson(
    userPrompt, systemPrompt,
    { name: 'rewrite_and_audit', schema: REWRITE_AUDIT_SCHEMA },
    rewriteTimeoutMs,
    REWRITE_MODEL
  );

  if (!raw?.is_valid) return { isValid: false, discardReason: sanitizeText(raw?.discard_reason).slice(0,240) || 'No apta editorialmente.' };

  const quality = validateEditorialQuality(raw?.body_html ?? '');
  if (quality.words < editorialMinWords) return { isValid: false, discardReason: `Contenido muy corto (< ${editorialMinWords} palabras).` };
  if (quality.uniquenessRatio < editorialMinUniqueRatio) return { isValid: false, discardReason: `Baja unicidad (< ${editorialMinUniqueRatio}).` };
  if (quality.headings < editorialMinHeadings) return { isValid: false, discardReason: `Sin subtítulos (< ${editorialMinHeadings} H2/H3).` };

  const tags           = toArray(raw?.tags).map(normalizeTag).filter(Boolean).slice(0, 8);
  const title          = sanitizeText(raw?.title);
  const rawImpactText  = sanitizeText(raw?.impact_text);
  const rawAnalysis    = sanitizeText(raw?.analysis_text);

  if (!isImpactTextValid(rawImpactText))  console.warn(`[ai] impact_text insuficiente para "${title.slice(0,60)}" (${rawImpactText.length} chars)`);
  if (!isAnalysisTextValid(rawAnalysis))  console.warn(`[ai] analysis_text insuficiente para "${title.slice(0,60)}" (${rawAnalysis.length} chars)`);

  const impactText        = rawImpactText;
  const analysisText      = rawAnalysis;
  const mergedAnalysisText = mergeAnalysisAndImpact(analysisText, impactText);
  const bodyHtml          = addEditorialLayer(raw?.body_html ?? '', data);

  return {
    isValid: true, discardReason: '',
    title: title || data.title,
    slug: slugify(raw?.slug || title || data.title).slice(0,120) || data.id || 'noticia-economia',
    excerpt: sanitizeText(raw?.excerpt) || data.excerpt,
    bodyHtml,
    analysisText, impactText, mergedAnalysisText,
    seoTitle:       sanitizeText(raw?.seo_title)  || title || data.title,
    seoDescription: sanitizeText(raw?.seo_description) || data.excerpt,
    tags: [...new Set(tags)],
    readTimeMinutes: Math.max(3, Number(raw?.read_time_minutes) || 3),
    featured: Boolean(raw?.featured),
    isPublished: true,
    isDiscarded: Boolean(raw?.is_discarded),
    authorName:  sanitizeText(raw?.author_name)  || 'Equipo Editorial DolarPeruHoy',
    reviewedBy:  sanitizeText(raw?.reviewed_by)  || 'Equipo Editorial DolarPeruHoy',
    contentMetrics: calculateContentMetrics(bodyHtml),
  };
}