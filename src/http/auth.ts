import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { BusinessError } from './errors.js';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireKey(header: string, expected: string): RequestHandler {
  return (req, _res, next) => {
    const given = req.header(header) ?? '';
    if (!expected || !safeEqual(given, expected)) {
      next(new BusinessError('UNAUTHORIZED'));
      return;
    }
    next();
  };
}
