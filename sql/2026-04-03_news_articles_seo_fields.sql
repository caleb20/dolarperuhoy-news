-- Add SEO/navigation fields used by the scraper
alter table public.news_articles
  add column if not exists tags text[] not null default '{}',
  add column if not exists featured_image text,
  add column if not exists analysis_text text;

-- Fast filtering/navigation by tags
create index if not exists idx_news_articles_tags_gin
  on public.news_articles using gin (tags);

-- Optional full-text search index for analysis text
create index if not exists idx_news_articles_analysis_fts
  on public.news_articles
  using gin (to_tsvector('spanish', coalesce(analysis_text, '')));
