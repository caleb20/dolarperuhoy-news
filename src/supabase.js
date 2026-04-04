import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';

loadEnv();
loadEnv({ path: '.env.local', override: true });

if (!process.env.SCRAPER_SUPABASE_URL || !process.env.SCRAPER_SUPABASE_KEY) {
  loadEnv({ path: '.env.example' });
}

const supabaseUrl = process.env.SCRAPER_SUPABASE_URL;
const supabaseKey = process.env.SCRAPER_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase env vars. Set SCRAPER_SUPABASE_URL and SCRAPER_SUPABASE_KEY in .env or .env.local.'
  );
}

export const supabase = createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);