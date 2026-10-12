export interface StructuredLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  correlationId?: string;
  jobId?: string;
  agentId?: string;
  context?: Record<string, unknown>;
}

export class Logger {
  constructor(private defaultContext: { agentId?: string; service?: string } = {}) {}

  private log(
    level: StructuredLog['level'],
    message: string,
    meta?: { jobId?: string; correlationId?: string; [key: string]: unknown }
  ) {
    const { jobId, correlationId, ...rest } = meta || {};
    const entry: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      message,
      agentId: this.defaultContext.agentId,
      jobId,
      correlationId,
      context: Object.keys(rest).length ? rest : undefined,
    };
    const json = JSON.stringify(entry);
    if (level === 'error') {
      console.error(json);
    } else if (level === 'warn') {
      console.warn(json);
    } else {
      console.log(json);
    }
  }

  info(msg: string, meta?: Record<string, unknown>) {
    this.log('info', msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>) {
    this.log('warn', msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>) {
    this.log('error', msg, meta);
  }

  debug(msg: string, meta?: Record<string, unknown>) {
    this.log('debug', msg, meta);
  }
}
