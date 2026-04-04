import 'dotenv/config';
import { runCycle } from './scraper.js';
try {
  const summary = await runCycle();
  console.log('[news] resumen:', summary);
} catch (error) {
  console.error('[news] error fatal:', error.message);
  process.exitCode = 1;
}