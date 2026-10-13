import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { OrderService } from './order-service.js';
import { AppError } from './security.js';
import { UpstreamError } from './chain/http.js';

const quoteInput = z.object({
  routeId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  amount: z.string().min(1).max(72).regex(/^\d{1,40}(?:\.\d{1,30})?$/),
  sourceAddress: z.string().min(30).max(64),
  recipient: z.string().regex(/^0x[\da-fA-F]{40}$/),
}).strict();
const orderInput = z.object({ quoteId: z.string().regex(/^[\w-]{32}$/) }).strict();
const transactionInput = z.object({ txHash: z.string().min(64).max(66) }).strict();
const idSchema = z.string().regex(/^[\w-]{32}$/);

export interface HttpOptions {
  allowedOrigins: string[]; staticDir?: string; version?: string;
  logging?: boolean; rateLimitMax?: number; trustProxyHops?: number;
}

export function createApp(service: OrderService, options: HttpOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Do not trust arbitrary X-Forwarded-For. Single-instance production ingress can be configured separately.
  if (options.trustProxyHops !== undefined && options.trustProxyHops !== 1) throw new Error('Only a single explicitly trusted proxy hop is supported.');
  app.set('trust proxy', options.trustProxyHops ?? false);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    connectSrc: ["'self'", 'https://api.trongrid.io', 'https://api.tronstack.io', 'https://tron-rpc.publicnode.com'],
    imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"],
  } } }));
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    const start = Date.now();
    if (options.logging !== false) res.once('finish', () => {
      // Never include bodies, query strings, Authorization, idempotency keys, or upstream responses.
      console.info(JSON.stringify({ requestId: res.locals.requestId, method: req.method,
        route: String(req.route?.path ?? 'unmatched'), status: res.statusCode, durationMs: Date.now() - start }));
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && !options.allowedOrigins.includes(origin)) return next(new AppError('ORIGIN_NOT_ALLOWED', '请求来源不被允许。', 403));
    if (req.get('sec-fetch-site') === 'cross-site' && !origin) return next(new AppError('ORIGIN_NOT_ALLOWED', '不接受跨站请求。', 403));
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: options.rateLimitMax ?? 120,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试。', 429)),
  }));
  app.use('/api', (req, _res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) return next(new AppError('JSON_REQUIRED', '请使用 application/json 请求体。', 415));
    next();
  });
  app.use('/api', express.json({ limit: '16kb', strict: true }));

  const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
  const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '请求参数格式无效，请检查地址、金额及必填字段。');
    return parsed.data;
  };
  const credentials = (req: express.Request): { id: string; token: string } => {
    const id = parse(idSchema, req.params.id);
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '');
    if (!match) throw new AppError('AUTHENTICATION_REQUIRED', '需要有效的订单访问令牌。', 401);
    return { id, token: match[1] };
  };

  app.get('/api/health', (_req, res) => { res.json({ status: 'ok', version: options.version ?? '0.1.0' }); });
  app.get('/api/config', asyncRoute(async (_req, res) => { res.json(await service.config()); }));
  app.post('/api/quotes', asyncRoute(async (req, res) => { res.status(201).json(await service.quote(parse(quoteInput, req.body))); }));
  app.post('/api/orders', (req, res, next) => {
    try {
      const { quoteId } = parse(orderInput, req.body);
      const key = req.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new AppError('INVALID_IDEMPOTENCY_KEY', '请提供 16–128 字符的随机 Idempotency-Key。');
      res.status(201).json(service.create(quoteId, key));
    } catch (error) { next(error); }
  });
  app.get('/api/orders/:id', asyncRoute(async (req, res) => {
    const { id, token } = credentials(req);
    res.json(await service.get(id, token));
  }));
  app.post('/api/orders/:id/transaction', asyncRoute(async (req, res) => {
    const { id, token } = credentials(req);
    const { txHash } = parse(transactionInput, req.body);
    res.json(await service.submit(id, token, txHash));
  }));
  app.post('/api/orders/:id/refresh', asyncRoute(async (req, res) => {
    const { id, token } = credentials(req);
    parse(z.object({}).strict(), req.body ?? {});
    res.json(await service.refresh(id, token));
  }));
  app.get('/api/account/:address', asyncRoute(async (req, res) => {
    const address = parse(z.string().regex(/^0x[\da-fA-F]{40}$/), req.params.address);
    res.json(await service.provider.getAccount(address));
  }));
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', '接口不存在。', 404)));
  if (options.staticDir && existsSync(resolve(options.staticDir, 'index.html'))) {
    app.use(express.static(options.staticDir, { index: false }));
    app.get(/.*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(resolve(options.staticDir!, 'index.html')); });
  }
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    let known = error instanceof AppError ? error : undefined;
    if (!known && error instanceof UpstreamError) {
      const safeErrors: Record<string, [string, number]> = {
        INVALID_ADDRESS: ['钱包地址未通过校验。', 400], INVALID_AMOUNT: ['金额未满足来源资产精度或路线限额。', 400],
        UNSUPPORTED_ROUTE: ['该入金路线不受支持。', 400], UNSAFE_PROVIDER_QUOTE: ['上游报价未通过安全核验，已停止该次请求。', 502],
        PROVIDER_AUTH_REQUIRED: ['上游拒绝访问，请由运营方检查 API 凭据或地区可用性。', 503],
        PROVIDER_RATE_LIMIT: ['上游暂时限流，请稍后重试。', 503], UPSTREAM_HTTP_ERROR: ['上游服务暂不可用，请稍后重试。', 503],
        UPSTREAM_UNAVAILABLE: ['无法连接上游服务，交易状态尚未改变。', 503],
        UPSTREAM_RESPONSE_TOO_LARGE: ['上游响应超过安全大小限制。', 502], INVALID_UPSTREAM_RESPONSE: ['上游未返回有效数据。', 502],
      };
      const safe = safeErrors[error.code];
      if (safe) known = new AppError(error.code, safe[0], safe[1]);
    }
    if (!known && error && typeof error === 'object' && 'type' in error) {
      if (error.type === 'entity.too.large') known = new AppError('BODY_TOO_LARGE', '请求体超过大小限制。', 413);
      if (error.type === 'entity.parse.failed') known = new AppError('INVALID_JSON', '请求体不是有效 JSON。');
    }
    res.status(known?.httpStatus ?? 502).json({ error: {
      code: known?.code ?? 'UPSTREAM_UNAVAILABLE',
      message: known?.message ?? '暂时无法取得可信的上游数据，请稍后再试。不会自动执行付款。',
      requestId: res.locals.requestId,
    } });
  };
  app.use(errorHandler);
  return app;
}
