export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface RateLimit {
  used_percent: number;
  window_minutes: number;
  resets_in_seconds?: number;
  resets_at?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export interface RateLimitWindow {
  primary?: RateLimit;    // 5-hour limit
  secondary?: RateLimit;  // Weekly limit
}

export interface RateLimitSource {
  kind: 'token_count' | 'app_server' | 'session_snapshot';
  label: string;
  detail?: string;
}

export interface TokenCountPayload {
  type: 'token_count';
  info: {
    total_token_usage: TokenUsage | null;
    last_token_usage: TokenUsage | null;
  } | null;
  rate_limits?: RateLimitWindow | null;
}

export interface EventRecord {
  type: 'event_msg';
  timestamp: string;
  payload: TokenCountPayload;
}

export interface RateLimitData {
  file_path: string;
  record_timestamp: Date;
  current_time: Date;
  total_usage: TokenUsage;
  last_usage: TokenUsage;
  rate_limit_source?: RateLimitSource;
  primary?: {
    used_percent: number;
    time_percent: number;
    reset_time: Date;
    outdated: boolean;
    window_minutes: number;
  };
  secondary?: {
    used_percent: number;
    time_percent: number;
    reset_time: Date;
    outdated: boolean;
    window_minutes: number;
  };
}

export interface ParseResult {
  found: boolean;
  data?: RateLimitData;
  error?: string;
}
