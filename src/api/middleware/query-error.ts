import type { Request, Response } from 'express'

// Logs the full Supabase PostgrestError to stdout and returns it as the
// 502 body. Temporary — remove console.error once the root cause is found.
export function sendQueryError(req: Request, res: Response, error: unknown): void {
  const e = error as Record<string, unknown>
  console.error(
    `[QUERY ERROR] ${req.method} ${req.path}`,
    JSON.stringify({ message: e?.message, code: e?.code, hint: e?.hint, details: e?.details }),
  )
  res.status(502).json({
    error:   String(e?.message  ?? 'Query failed'),
    code:    e?.code    ?? null,
    hint:    e?.hint    ?? null,
    details: e?.details ?? null,
  })
}
