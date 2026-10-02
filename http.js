import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Validate req data with a zod schema; throws 400 with a readable message. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new HttpError(400, msg);
  }
  return r.data;
}

export function errorHandler(err, req, res, _next) {
  if (err.code === '23505') return res.status(409).json({ error: friendlyUnique(err) });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error — check the logs' : err.message, ...(err.extra || {}) });
}

function friendlyUnique(err) {
  const m = /Key \((.+?)\)=\((.+?)\)/.exec(err.detail || '');
  return m ? `${m[1]} "${m[2]}" already exists` : 'Duplicate value';
}

export { z };
