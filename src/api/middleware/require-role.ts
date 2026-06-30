import type { RequestHandler } from 'express'
import type { EvidenceActorRole } from '../../db/types'

// Synchronous role-check middleware. Must be used after requireAuth, which resolves
// res.locals.actorRole from exporter_users.role in the same DB call.
//
// Usage: router.patch('/path', requireRole('reviewer', 'admin'), handler)
export function requireRole(...allowedRoles: EvidenceActorRole[]): RequestHandler {
  return (_req, res, next) => {
    const actorRole = res.locals.actorRole
    if (!allowedRoles.includes(actorRole)) {
      res.status(403).json({
        data:      null,
        error:     `Actor role '${actorRole}' is not permitted to call this endpoint`,
        code:      'FORBIDDEN',
        actorRole,
      })
      return
    }
    next()
  }
}
