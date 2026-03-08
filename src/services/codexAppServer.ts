import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RateLimit, RateLimitWindow } from '../interfaces/types';
import { log } from './logger';

const APP_SERVER_CACHE_TTL_MS = 15 * 1000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 5 * 1000;
const CHATGPT_EXTENSION_ID = 'openai.chatgpt';

type AppServerRateLimitWindow = {
  resetsAt?: number | null;
  usedPercent: number;
  windowDurationMins?: number | null;
};

type AppServerRateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
};

type AppServerRateLimitsResponse = {
  rateLimits?: AppServerRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, AppServerRateLimitSnapshot | undefined> | null;
};

type AppServerRequestResult = {
  rateLimits: RateLimitWindow;
  source: string;
};

let cachedRateLimits:
  | {
      expiresAt: number;
      result: AppServerRequestResult | null;
    }
  | undefined;

let inflightRequest: Promise<AppServerRequestResult | null> | undefined;

function toExtensionRateLimit(rateLimit: AppServerRateLimitWindow | null | undefined): RateLimit | undefined {
  if (!rateLimit) {
    return undefined;
  }

  return {
    used_percent: rateLimit.usedPercent,
    window_minutes: typeof rateLimit.windowDurationMins === 'number' ? rateLimit.windowDurationMins : 0,
    reset_at: typeof rateLimit.resetsAt === 'number' ? rateLimit.resetsAt : undefined
  };
}

function selectSnapshot(response: AppServerRateLimitsResponse): AppServerRateLimitSnapshot | null {
  if (response.rateLimitsByLimitId?.codex) {
    return response.rateLimitsByLimitId.codex;
  }

  if (response.rateLimitsByLimitId) {
    for (const snapshot of Object.values(response.rateLimitsByLimitId)) {
      if (snapshot) {
        return snapshot;
      }
    }
  }

  return response.rateLimits ?? null;
}

function normalizeRateLimits(response: AppServerRateLimitsResponse): RateLimitWindow | null {
  const snapshot = selectSnapshot(response);
  if (!snapshot) {
    return null;
  }

  const primary = toExtensionRateLimit(snapshot.primary);
  const secondary = toExtensionRateLimit(snapshot.secondary);

  if (!primary && !secondary) {
    return null;
  }

  return { primary, secondary };
}

function getBundledCodexExecutableCandidates(): string[] {
  const extension = vscode.extensions.getExtension(CHATGPT_EXTENSION_ID);
  if (!extension) {
    return [];
  }

  const binRoot = path.join(extension.extensionPath, 'bin');
  const candidates: string[] = [];

  switch (process.platform) {
    case 'win32':
      candidates.push(
        path.join(binRoot, 'windows-x86_64', 'codex.exe'),
        path.join(binRoot, 'windows-arm64', 'codex.exe')
      );
      break;
    case 'darwin':
      candidates.push(
        path.join(binRoot, process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64', 'codex'),
        path.join(binRoot, 'darwin-aarch64', 'codex'),
        path.join(binRoot, 'darwin-x86_64', 'codex')
      );
      break;
    case 'linux':
      candidates.push(
        path.join(binRoot, process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64', 'codex'),
        path.join(binRoot, 'linux-aarch64', 'codex'),
        path.join(binRoot, 'linux-x86_64', 'codex')
      );
      break;
    default:
      break;
  }

  return candidates.filter(candidate => fs.existsSync(candidate));
}

function getCodexExecutableCandidates(): string[] {
  const bundledCandidates = getBundledCodexExecutableCandidates();
  const candidates = [...bundledCandidates, 'codex'];
  return Array.from(new Set(candidates));
}

function parseResponseLine(line: string): unknown {
  return JSON.parse(line) as unknown;
}

function requestRateLimitsFromExecutable(executable: string): Promise<AppServerRequestResult | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ['app-server', '--listen', 'stdio://', '--analytics-default-enabled'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    );

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let initialized = false;

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for Codex app-server response from ${executable}`));
    }, APP_SERVER_REQUEST_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timeout);
      child.stdout.removeListener('data', handleStdout);
      child.stderr.removeListener('data', handleStderr);
      child.removeListener('error', handleError);
      child.removeListener('close', handleClose);
    }

    function finish(error?: Error, result?: AppServerRequestResult | null): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      try {
        child.stdin.end();
      } catch {
        // Ignore teardown errors.
      }

      if (!child.killed) {
        try {
          child.kill();
        } catch {
          // Ignore teardown errors.
        }
      }

      if (error) {
        reject(error);
        return;
      }

      resolve(result ?? null);
    }

    function writeMessage(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message: unknown): void {
      if (!message || typeof message !== 'object') {
        return;
      }

      const jsonMessage = message as {
        id?: number | string;
        result?: unknown;
        error?: { message?: string };
      };

      if (jsonMessage.id === 1) {
        if (jsonMessage.error) {
          finish(new Error(jsonMessage.error.message || `Failed to initialize Codex app-server via ${executable}`));
          return;
        }

        if (!initialized) {
          initialized = true;
          writeMessage({
            id: 2,
            method: 'account/rateLimits/read',
            params: null
          });
        }

        return;
      }

      if (jsonMessage.id !== 2) {
        return;
      }

      if (jsonMessage.error) {
        finish(new Error(jsonMessage.error.message || `Failed to read Codex rate limits via ${executable}`));
        return;
      }

      const normalized = normalizeRateLimits((jsonMessage.result ?? null) as AppServerRateLimitsResponse);
      if (!normalized) {
        finish(undefined, null);
        return;
      }

      finish(undefined, {
        rateLimits: normalized,
        source: executable
      });
    }

    function processStdoutBuffer(): void {
      let newlineIndex = stdoutBuffer.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          try {
            handleMessage(parseResponseLine(line));
          } catch (error) {
            log(`Failed to parse Codex app-server output from ${executable}: ${error}`, 'warn');
          }
        }

        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    }

    function handleStdout(chunk: Buffer | string): void {
      stdoutBuffer += chunk.toString();
      processStdoutBuffer();
    }

    function handleStderr(chunk: Buffer | string): void {
      stderrBuffer += chunk.toString();
    }

    function handleError(error: Error): void {
      finish(new Error(`Failed to start Codex app-server via ${executable}: ${error.message}`));
    }

    function handleClose(code: number | null): void {
      if (settled) {
        return;
      }

      const stderrMessage = stderrBuffer.trim();
      const closeMessage = stderrMessage || `Codex app-server exited before returning a response (code: ${code ?? 'unknown'})`;
      finish(new Error(closeMessage));
    }

    child.stdout.on('data', handleStdout);
    child.stderr.on('data', handleStderr);
    child.on('error', handleError);
    child.on('close', handleClose);

    writeMessage({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex-ratelimit',
          version: '0.13.0'
        }
      }
    });
  });
}

async function fetchRateLimitsFromAppServer(): Promise<AppServerRequestResult | null> {
  const executables = getCodexExecutableCandidates();
  const failures: string[] = [];

  for (const executable of executables) {
    try {
      const result = await requestRateLimitsFromExecutable(executable);
      if (result) {
        return result;
      }

      failures.push(`${executable}: no usable rate limits returned`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      failures.push(`${executable}: ${errorMessage}`);
    }
  }

  if (failures.length > 0) {
    log(`Codex app-server fallback failed for all candidates: ${failures.join(' | ')}`, 'warn');
  }

  return null;
}

export async function getCodexRateLimitsFromAppServer(): Promise<AppServerRequestResult | null> {
  const now = Date.now();

  if (cachedRateLimits && cachedRateLimits.expiresAt > now) {
    return cachedRateLimits.result;
  }

  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = fetchRateLimitsFromAppServer()
    .then(result => {
      cachedRateLimits = {
        expiresAt: Date.now() + APP_SERVER_CACHE_TTL_MS,
        result
      };

      return result;
    })
    .finally(() => {
      inflightRequest = undefined;
    });

  return inflightRequest;
}
