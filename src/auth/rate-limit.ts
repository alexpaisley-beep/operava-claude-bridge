import type { NextFunction, Request, Response } from 'express';

/**
 * Small in-memory sliding-window rate limiter. Suitable for the single-instance
 * API service; a multi-instance deployment should front this with an edge
 * limiter as well.
 */
export function createRateLimiter(opts: {
  requestsPerMinute: number;
  keyFor: (req: Request) => string;
  name: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const windows = new Map<string, number[]>();
  const WINDOW_MS = 60_000;
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > WINDOW_MS) {
      lastSweep = now;
      for (const [key, hits] of windows) {
        const kept = hits.filter((t) => now - t < WINDOW_MS);
        if (kept.length === 0) windows.delete(key);
        else windows.set(key, kept);
      }
    }
    const key = opts.keyFor(req);
    const hits = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (hits.length >= opts.requestsPerMinute) {
      res
        .status(429)
        .json({ error: { code: 'RATE_LIMITED', message: `Rate limit exceeded for ${opts.name}.` } });
      return;
    }
    hits.push(now);
    windows.set(key, hits);
    next();
  };
}

export function clientIpKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function bearerKey(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.length > 0 ? header.slice(-24) : clientIpKey(req);
}
