import jwt from 'jsonwebtoken'
import type { RequestHandler } from 'express'
import type { DbClient } from '../../db/client'

declare global {
  namespace Express {
    interface Locals {
      userId: string
      exporterId: string
    }
  }
}

export function requireAuth(pool: DbClient): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const token = header.slice(7)
    const secret = process.env.JWT_SECRET
    if (!secret) {
      res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' })
      return
    }

    let payload: jwt.JwtPayload
    try {
      payload = jwt.verify(token, secret) as jwt.JwtPayload
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }

    const userId = payload['sub']
    if (!userId) {
      res.status(401).json({ error: 'Malformed token' })
      return
    }

    try {
      const { rows } = await pool.query<{ exporter_id: string }>(
        'SELECT exporter_id FROM exporter_users WHERE user_id = $1 LIMIT 1',
        [userId],
      )
      if (!rows.length) {
        res.status(403).json({ error: 'No exporter access for this account' })
        return
      }
      res.locals.userId = userId
      res.locals.exporterId = rows[0].exporter_id
      next()
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}
