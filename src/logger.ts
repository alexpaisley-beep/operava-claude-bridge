import { pino, type Logger } from 'pino';

/**
 * Structured logging with hard redaction of anything that could carry a
 * credential. Task/run correlation IDs are attached via child loggers.
 */
export function createLogger(opts: { level: string; service: string }): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.service },
    redact: {
      paths: [
        'token',
        'accessToken',
        'refreshToken',
        'authorization',
        'password',
        'secret',
        'clientSecret',
        'apiKey',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.authorization',
        '*.password',
        '*.secret',
        '*.clientSecret',
        '*.apiKey',
        'req.headers.authorization',
        'headers.authorization',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

export type { Logger };
