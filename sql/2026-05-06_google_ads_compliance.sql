-- Google Ads Compliance Updates
-- Agrega campos necesarios para auditoría editorial y publicación controlada

ALTER TABLE IF EXISTS public.news_articles
ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'pending_review',
ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255),
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS content_metrics JSONB;

-- Índices para queries de auditoría
CREATE INDEX IF NOT EXISTS idx_news_articles_review_status 
ON public.news_articles(review_status);

CREATE INDEX IF NOT EXISTS idx_news_articles_approved_at 
ON public.news_articles(approved_at DESC);

-- Constraint: review_status debe tener valores válidos
ALTER TABLE IF EXISTS public.news_articles
ADD CONSTRAINT check_review_status 
CHECK (review_status IN ('draft', 'pending_review', 'approved', 'rejected', 'published'));

-- Política RLS: Solo editores pueden aprobar artículos
-- (asume que tienes tabla roles/users configurada)
-- GRANT UPDATE ON public.news_articles TO "authenticated" 
-- USING (auth.jwt() ->> 'role' = 'editor');

COMMENT ON COLUMN public.news_articles.review_status 
IS 'Estado del artículo: draft→pending_review→approved→published. Google Ads requiere intervención humana.';

COMMENT ON COLUMN public.news_articles.content_metrics 
IS 'Métricas de calidad: {totalWords, uniqueWords, uniqueRatio, stopwordRatio, hasSubheadings}';

COMMENT ON COLUMN public.news_articles.approved_by 
IS 'ID o email del editor que aprobó la publicación. Auditoría requerida por Google Ads.';
