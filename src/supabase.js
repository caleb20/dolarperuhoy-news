import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SCRAPER_SUPABASE_URL,
  process.env.SCRAPER_SUPABASE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);