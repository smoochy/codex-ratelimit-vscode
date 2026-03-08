import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

type ActiveLogLevel = Exclude<LogLevel, 'off'>;

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 50
};

export function initializeLogging(): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Codex Rate Limit');
  }
}

function getConfiguredLogLevel(config: vscode.WorkspaceConfiguration): LogLevel {
  const inspected = config.inspect<LogLevel>('logLevel');
  const hasExplicitLogLevel =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined;

  if (hasExplicitLogLevel) {
    return config.get<LogLevel>('logLevel', 'warn');
  }

  return config.get<boolean>('enableLogging', false) ? 'info' : 'warn';
}

function shouldLog(config: vscode.WorkspaceConfiguration, level: ActiveLogLevel): boolean {
  const configuredLevel = getConfiguredLogLevel(config);
  if (configuredLevel === 'off') {
    return false;
  }

  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function formatLevel(level: ActiveLogLevel): string {
  return level.toUpperCase().padEnd(5, ' ');
}

export function log(message: string, level: ActiveLogLevel = 'info'): void {
  const config = vscode.workspace.getConfiguration('codexRatelimit');
  const showOutputOnError = config.get<boolean>('showOutputOnError', false);

  if (!shouldLog(config, level)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${formatLevel(level)}] ${message}`;

  if (outputChannel) {
    outputChannel.appendLine(logMessage);
    if (level === 'error' && showOutputOnError) {
      outputChannel.show(true);
    }
  }

  switch (level) {
    case 'error':
      console.error(logMessage);
      break;
    case 'warn':
      console.warn(logMessage);
      break;
    default:
      console.log(logMessage);
  }
}

export function dispose(): void {
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
  }
}
