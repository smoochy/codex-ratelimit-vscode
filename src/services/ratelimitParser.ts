import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { glob } from 'glob';
import * as vscode from 'vscode';
import { EventRecord, ParseResult, RateLimit, RateLimitData, RateLimitSource, RateLimitWindow, TokenUsage } from '../interfaces/types';
import { getCodexRateLimitsFromAppServer } from './codexAppServer';
import { log } from './logger';

type RateLimitSection = NonNullable<RateLimitData['primary']>;

type SessionRecordMatch = {
  file: string;
  record: EventRecord;
};

type SessionFileParseResult = {
  latestRecord: EventRecord | null;
  latestRateLimitRecord: EventRecord | null;
};

function getSessionBasePath(customPath?: string): string {
  if (customPath) {
    return path.resolve(customPath.replace('~', os.homedir()));
  }

  return path.join(os.homedir(), '.codex', 'sessions');
}

function calculateResetTime(referenceTime: Date, rateLimit: RateLimit): { resetTime: Date; isOutdated: boolean; secondsUntilReset: number } {
  const currentTime = new Date();
  let resetTime: Date | null = null;

  if (typeof rateLimit.reset_at === 'number' && !Number.isNaN(rateLimit.reset_at)) {
    resetTime = new Date(rateLimit.reset_at * 1000);
  } else if (typeof rateLimit.resets_at === 'number' && !Number.isNaN(rateLimit.resets_at)) {
    resetTime = new Date(rateLimit.resets_at * 1000);
  } else if (typeof rateLimit.reset_after_seconds === 'number' && !Number.isNaN(rateLimit.reset_after_seconds)) {
    resetTime = new Date(referenceTime.getTime() + rateLimit.reset_after_seconds * 1000);
  } else if (typeof rateLimit.resets_in_seconds === 'number' && !Number.isNaN(rateLimit.resets_in_seconds)) {
    resetTime = new Date(referenceTime.getTime() + rateLimit.resets_in_seconds * 1000);
  }

  if (!resetTime || Number.isNaN(resetTime.getTime())) {
    return {
      resetTime: referenceTime,
      isOutdated: true,
      secondsUntilReset: 0
    };
  }

  const secondsUntilReset = Math.max(0, Math.floor((resetTime.getTime() - currentTime.getTime()) / 1000));
  const isOutdated = resetTime < currentTime;

  return { resetTime, isOutdated, secondsUntilReset };
}

function parseRecordTimestamp(timestamp: string): Date | null {
  const parsed = new Date(timestamp.replace('Z', '+00:00'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function parseSessionFile(filePath: string): Promise<SessionFileParseResult> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    let latestRecord: EventRecord | null = null;
    let latestRecordTimestamp: Date | null = null;
    let latestRateLimitRecord: EventRecord | null = null;
    let latestRateLimitTimestamp: Date | null = null;

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as EventRecord;

        if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') {
          continue;
        }

        const timestamp = parseRecordTimestamp(record.timestamp);
        if (!timestamp) {
          continue;
        }

        if (!latestRecordTimestamp || timestamp > latestRecordTimestamp) {
          latestRecordTimestamp = timestamp;
          latestRecord = record;
        }

        if (record.payload.rate_limits && (!latestRateLimitTimestamp || timestamp > latestRateLimitTimestamp)) {
          latestRateLimitTimestamp = timestamp;
          latestRateLimitRecord = record;
        }
      } catch {
        continue;
      }
    }

    return {
      latestRecord,
      latestRateLimitRecord
    };
  } catch (error) {
    log(`Error reading session file ${filePath}: ${error}`, 'warn');
    return {
      latestRecord: null,
      latestRateLimitRecord: null
    };
  }
}

async function getSessionFilesWithMtime(sessionPath: string): Promise<{ file: string; mtimeMs: number }[]> {
  const sessionFiles: { file: string; mtimeMs: number }[] = [];
  const currentDate = new Date();

  for (let daysBack = 0; daysBack < 7; daysBack++) {
    const searchDate = new Date(currentDate);
    searchDate.setDate(currentDate.getDate() - daysBack);

    const year = searchDate.getFullYear();
    const month = String(searchDate.getMonth() + 1).padStart(2, '0');
    const day = String(searchDate.getDate()).padStart(2, '0');
    const datePath = path.join(sessionPath, String(year), month, day);

    if (!fs.existsSync(datePath)) {
      continue;
    }

    try {
      const pattern = path.join(datePath, 'rollout-*.jsonl').replace(/\\/g, '/');
      const files = await glob(pattern, { nodir: true });

      for (const file of files) {
        try {
          const stats = await fs.promises.stat(file);
          sessionFiles.push({ file, mtimeMs: stats.mtimeMs });
        } catch (error) {
          log(`Error getting mtime for session file ${file}: ${error}`, 'warn');
        }
      }
    } catch (error) {
      log(`Error collecting session files from ${datePath}: ${error}`, 'warn');
    }
  }

  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessionFiles;
}

async function getOrderedSessionFiles(sessionPath: string): Promise<string[]> {
  const nowMs = Date.now();
  const oneHourAgoMs = nowMs - 60 * 60 * 1000;
  const orderedFiles: string[] = [];
  const seenFiles = new Set<string>();

  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = String(today.getMonth() + 1).padStart(2, '0');
  const todayDay = String(today.getDate()).padStart(2, '0');
  const todayPath = path.join(sessionPath, String(todayYear), todayMonth, todayDay);

  if (fs.existsSync(todayPath)) {
    try {
      const pattern = path.join(todayPath, 'rollout-*.jsonl').replace(/\\/g, '/');
      const files = await glob(pattern, { nodir: true });
      const recentFiles: { file: string; mtimeMs: number }[] = [];

      for (const file of files) {
        try {
          const stats = await fs.promises.stat(file);
          if (stats.mtimeMs >= oneHourAgoMs) {
            recentFiles.push({ file, mtimeMs: stats.mtimeMs });
          }
        } catch (error) {
          log(`Error reading stats for session file ${file}: ${error}`, 'warn');
        }
      }

      recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const { file } of recentFiles) {
        seenFiles.add(file);
        orderedFiles.push(file);
      }
    } catch (error) {
      log(`Error searching today's session files in ${todayPath}: ${error}`, 'warn');
    }
  }

  const sessionFiles = await getSessionFilesWithMtime(sessionPath);
  for (const { file } of sessionFiles) {
    if (seenFiles.has(file)) {
      continue;
    }

    seenFiles.add(file);
    orderedFiles.push(file);
  }

  return orderedFiles;
}

async function findLatestSessionRecords(basePath?: string): Promise<{
  latestTokenCount: SessionRecordMatch | null;
  latestRateLimitRecord: SessionRecordMatch | null;
}> {
  const sessionPath = getSessionBasePath(basePath);

  if (!fs.existsSync(sessionPath)) {
    log(`Session path does not exist: ${sessionPath}`, 'warn');
    return {
      latestTokenCount: null,
      latestRateLimitRecord: null
    };
  }

  const orderedFiles = await getOrderedSessionFiles(sessionPath);
  let latestTokenCount: SessionRecordMatch | null = null;
  let latestRateLimitRecord: SessionRecordMatch | null = null;

  for (const file of orderedFiles) {
    if (latestTokenCount && latestRateLimitRecord) {
      break;
    }

    const parsed = await parseSessionFile(file);

    if (!latestTokenCount && parsed.latestRecord) {
      latestTokenCount = { file, record: parsed.latestRecord };
    }

    if (!latestRateLimitRecord && parsed.latestRateLimitRecord) {
      latestRateLimitRecord = { file, record: parsed.latestRateLimitRecord };
    }
  }

  return {
    latestTokenCount,
    latestRateLimitRecord
  };
}

function createEmptyTokenUsage(): TokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function createEmptyRateLimitData(sourceFile: string, currentTime: Date): RateLimitData {
  return {
    file_path: sourceFile,
    record_timestamp: currentTime,
    current_time: currentTime,
    total_usage: createEmptyTokenUsage(),
    last_usage: createEmptyTokenUsage()
  };
}

function setRateLimitSource(data: RateLimitData, source: RateLimitSource): void {
  data.rate_limit_source = source;
}

function buildRateLimitSection(referenceTime: Date, rateLimit: RateLimit): RateLimitSection {
  const { resetTime, isOutdated, secondsUntilReset } = calculateResetTime(referenceTime, rateLimit);
  const rawWindowMinutes = rateLimit.window_minutes;
  const windowMinutes = typeof rawWindowMinutes === 'number' && rawWindowMinutes > 0 ? rawWindowMinutes : 0;
  const windowSeconds = windowMinutes * 60;

  let timePercent: number;
  if (windowSeconds <= 0) {
    timePercent = 0;
  } else if (isOutdated) {
    timePercent = 100.0;
  } else {
    const elapsedSeconds = windowSeconds - secondsUntilReset;
    const boundedElapsedSeconds = Math.max(0, Math.min(windowSeconds, elapsedSeconds));
    timePercent = (boundedElapsedSeconds / windowSeconds) * 100;
  }

  return {
    used_percent: rateLimit.used_percent,
    time_percent: Math.max(0, Math.min(100, timePercent)),
    reset_time: resetTime,
    outdated: isOutdated,
    window_minutes: windowMinutes
  };
}

function applyRateLimits(data: RateLimitData, rateLimits: RateLimitWindow | null | undefined, referenceTime: Date): boolean {
  let applied = false;

  if (rateLimits?.primary) {
    data.primary = buildRateLimitSection(referenceTime, rateLimits.primary);
    applied = true;
  }

  if (rateLimits?.secondary) {
    data.secondary = buildRateLimitSection(referenceTime, rateLimits.secondary);
    applied = true;
  }

  return applied;
}

function formatTokenNumber(num: number): string {
  const numInK = Math.round(num / 1000);
  return numInK.toLocaleString('en-US') + ' K';
}

export async function getRateLimitData(customPath?: string): Promise<ParseResult> {
  try {
    const config = vscode.workspace.getConfiguration('codexRatelimit');
    const configuredSessionPath = customPath ?? config.get<string>('sessionPath', '');
    const sessionPath = configuredSessionPath.trim();
    const shouldUseAppServerFallback = !customPath && sessionPath.length === 0;

    log(`Searching for latest token_count event in ${sessionPath || 'default path'}...`, 'debug');

    const currentTime = new Date();
    const sessionRecords = await findLatestSessionRecords(sessionPath || undefined);
    const sessionResult = sessionRecords.latestTokenCount;
    const latestRateLimitRecord = sessionRecords.latestRateLimitRecord;

    let data = createEmptyRateLimitData(
      sessionResult?.file || latestRateLimitRecord?.file || 'Codex sessions',
      currentTime
    );

    if (sessionResult) {
      const { file, record } = sessionResult;
      const payload = record.payload;
      const info = payload.info;

      if (!info) {
        log('Token count payload missing usage info; defaulting to zero values.', 'warn');
      } else if (!info.total_token_usage || !info.last_token_usage) {
        log('Token count payload has incomplete usage info; defaulting missing fields to zero.', 'warn');
      }

      data = {
        file_path: file,
        record_timestamp: parseRecordTimestamp(record.timestamp) || currentTime,
        current_time: currentTime,
        total_usage: info?.total_token_usage ?? createEmptyTokenUsage(),
        last_usage: info?.last_token_usage ?? createEmptyTokenUsage()
      };

      log(`Found latest token_count event in: ${file}`, 'debug');
    }

    let appliedRateLimits = false;

    if (sessionResult) {
      appliedRateLimits = applyRateLimits(data, sessionResult.record.payload.rate_limits, data.record_timestamp);
      if (appliedRateLimits) {
        setRateLimitSource(data, {
          kind: 'token_count',
          label: 'Live session token_count',
          detail: sessionResult.file
        });
        log(`Using live session rate limits from: ${sessionResult.file}`, 'info');
      }
    }

    if (!appliedRateLimits && shouldUseAppServerFallback) {
      const appServerResult = await getCodexRateLimitsFromAppServer();

      if (appServerResult) {
        appliedRateLimits = applyRateLimits(data, appServerResult.rateLimits, currentTime);
        if (appliedRateLimits) {
          setRateLimitSource(data, {
            kind: 'app_server',
            label: 'Codex app-server fallback',
            detail: appServerResult.source
          });
          log(`Using Codex app-server fallback rate limits from: ${appServerResult.source}`, 'info');
        }
      }
    }

    if (!appliedRateLimits && latestRateLimitRecord?.record.payload.rate_limits) {
      const referenceTime = parseRecordTimestamp(latestRateLimitRecord.record.timestamp) || currentTime;
      appliedRateLimits = applyRateLimits(data, latestRateLimitRecord.record.payload.rate_limits, referenceTime);
      if (appliedRateLimits) {
        setRateLimitSource(data, {
          kind: 'session_snapshot',
          label: 'Session snapshot fallback',
          detail: latestRateLimitRecord.file
        });
        log(`Using most recent session rate limits from: ${latestRateLimitRecord.file}`, 'info');
      }
    }

    if (!sessionResult && !appliedRateLimits) {
      return {
        found: false,
        error: 'No token_count events or rate-limit snapshots found in recent Codex sessions'
      };
    }

    return {
      found: true,
      data
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log(`Error getting rate limit data: ${errorMessage}`, 'error');
    return {
      found: false,
      error: errorMessage
    };
  }
}

export function formatTokenUsage(usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number }): string {
  return `input ${formatTokenNumber(usage.input_tokens)}, cached ${formatTokenNumber(usage.cached_input_tokens)}, output ${formatTokenNumber(usage.output_tokens)}, reasoning ${formatTokenNumber(usage.reasoning_output_tokens)}`;
}
