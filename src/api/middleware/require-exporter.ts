import type { Request, Response, NextFunction } from 'express'

declare global {
  namespace Express {
    interface Locals {
      exporterId: string
    }
  }
}

// SECURITY NOTE — X-Exporter-Id is a temporary mechanism for local and
// internal testing only. It must NOT be used in production as-is. Any
// HTTP client can forge this header, so there is no authentication
// guarantee here.
//
// When real auth is added, exporter_id must be derived from the
// authenticated user's verified JWT — either from a custom claim or by
// looking up exporter_users membership (the current_user_exporter_ids()
// RLS helper in the database already does exactly this). The header
// approach bypasses all of that and is only safe when the API is not
// publicly reachable (e.g., behind a firewall, or called only from
// trusted internal tooling that already holds a service-role key).
export function requireExporterId(req: Request, res: Response, next: NextFunction): void {
  const exporterId = req.headers['x-exporter-id']
  if (!exporterId || typeof exporterId !== 'string') {
    res.status(400).json({ error: 'X-Exporter-Id header is required' })
    return
  }
  res.locals.exporterId = exporterId
  next()
}
