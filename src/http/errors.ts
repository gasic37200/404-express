import type { ErrorRequestHandler, RequestHandler } from 'express';
import { error } from './response.js';

export const ErrorCode = {
  BAD_REQUEST_DATA: [400, '잘못된 요청입니다.'],
  INVALID_FIELD_ERROR: [400, '요청 필드 값이 유효하지 않습니다.'],
  INVALID_IDEMPOTENCY_KEY: [400, 'Idempotency-Key 헤더가 없거나 형식이 올바르지 않습니다.'],
  UNAUTHORIZED: [401, '인증 키가 올바르지 않습니다.'],
  RESOURCE_NOT_FOUND: [404, '요청한 리소스를 찾을 수 없습니다.'],
  SHIPMENT_NOT_FOUND: [404, '배송 건을 찾을 수 없습니다.'],
  WEBHOOK_EVENT_NOT_FOUND: [404, '웹훅 이벤트를 찾을 수 없습니다.'],
  IDEMPOTENCY_KEY_REUSED: [409, '같은 Idempotency-Key로 다른 내용의 요청이 들어왔습니다.'],
  SHIPMENT_NOT_CANCELLABLE: [409, '수거 이후에는 취소할 수 없습니다.'],
  INVALID_STATE_TRANSITION: [409, '더 이상 진행할 수 없는 상태입니다.'],
  WEBHOOK_EVENT_NOT_DEAD: [409, 'DEAD 상태인 이벤트만 재전송할 수 있습니다.'],
  INTERNAL_ERROR: [500, '서버 내부 오류가 발생했습니다.'],
} as const satisfies Record<string, readonly [number, string]>;

export type ErrorCodeName = keyof typeof ErrorCode;

export class BusinessError extends Error {
  readonly status: number;

  constructor(readonly code: ErrorCodeName, message?: string) {
    super(message ?? ErrorCode[code][1]);
    this.status = ErrorCode[code][0];
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  const [status, message] = ErrorCode.RESOURCE_NOT_FOUND;
  res.status(status).json(error(status, 'RESOURCE_NOT_FOUND', message));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof BusinessError) {
    res.status(err.status).json(error(err.status, err.code, err.message));
    return;
  }
  // express.json()의 JSON 파싱 실패
  if (err?.type === 'entity.parse.failed') {
    const [status, message] = ErrorCode.BAD_REQUEST_DATA;
    res.status(status).json(error(status, 'BAD_REQUEST_DATA', message));
    return;
  }
  console.error('Unexpected exception', err);
  const [status, message] = ErrorCode.INTERNAL_ERROR;
  res.status(status).json(error(status, 'INTERNAL_ERROR', message));
};
