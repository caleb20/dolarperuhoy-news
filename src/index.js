import 'dotenv/config';
import { runCycle } from './scraper.js';

let exitCode = 0;

try {
  const summary = await runCycle();
  console.log('[news] resumen:', summary);
} catch (error) {
  console.error('[news] error fatal:', error.message);
  exitCode = 1;
}

process.exit(exitCode);