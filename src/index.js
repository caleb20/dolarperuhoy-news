import 'dotenv/config';
import { runCycle } from './scraper.js';

const SCHEDULE_TIMEZONE = process.env.NEWS_SCHEDULE_TZ ?? 'America/Lima';
const DEFAULT_TIMES = ['06:00', '12:00', '18:00'];
const runningLock = { active: false };

function parseScheduleTimes() {
  const raw = String(process.env.NEWS_SCHEDULE_TIMES ?? '').trim();
  const candidates = raw ? raw.split(',') : DEFAULT_TIMES;
  const unique = new Set();

  for (const candidate of candidates) {
    const value = String(candidate).trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match) {
      continue;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      continue;
    }

    unique.add(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }

  return [...unique].sort((a, b) => a.localeCompare(b));
}

function getLimaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const lookup = (type) => parts.find((part) => part.type === type)?.value;

  return {
    year: Number(lookup('year')),
    month: Number(lookup('month')),
    day: Number(lookup('day')),
    hour: Number(lookup('hour')),
    minute: Number(lookup('minute')),
  };
}

function nextRunDelayMs(timeHHMM) {
  const [targetHour, targetMinute] = timeHHMM.split(':').map(Number);
  const now = new Date();
  const nowParts = getLimaDateParts(now);

  const nowTotalMinutes = nowParts.hour * 60 + nowParts.minute;
  const targetTotalMinutes = targetHour * 60 + targetMinute;
  const dayOffset = nowTotalMinutes < targetTotalMinutes ? 0 : 1;

  const targetUtc = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day + dayOffset,
    targetHour + 5,
    targetMinute,
    0,
    0
  );

  return Math.max(1_000, targetUtc - now.getTime());
}

async function runCycleSafe(triggerLabel) {
  if (runningLock.active) {
    console.log(`[news] ciclo omitido (${triggerLabel}) porque ya hay uno en curso`);
    return;
  }

  runningLock.active = true;
  try {
    const summary = await runCycle();
    console.log(`[news] resumen (${triggerLabel}):`, summary);
  } catch (error) {
    console.error(`[news] error fatal (${triggerLabel}):`, error.message);
  } finally {
    runningLock.active = false;
  }
}

function scheduleDailyRun(timeHHMM) {
  const planNext = () => {
    const delay = nextRunDelayMs(timeHHMM);
    setTimeout(async () => {
      await runCycleSafe(`horario ${timeHHMM}`);
      planNext();
    }, delay);
  };

  planNext();
}

const scheduleTimes = parseScheduleTimes();

if (scheduleTimes.length === 0) {
  console.error('[news] NEWS_SCHEDULE_TIMES invalido. Usa formato HH:mm,HH:mm,HH:mm');
  process.exitCode = 1;
} else {
  console.log(`[news] scheduler activo en ${SCHEDULE_TIMEZONE}. Horarios: ${scheduleTimes.join(', ')}`);

  if (process.env.NEWS_RUN_AT_STARTUP !== '0') {
    await runCycleSafe('inicio');
  }

  for (const time of scheduleTimes) {
    scheduleDailyRun(time);
  }
}