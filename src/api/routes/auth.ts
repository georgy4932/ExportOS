import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { DbClient } from '../../db/client'
import { requireAuth } from '../middleware/require-auth'

// DEV-ONLY AUTH — local_users is a v0.2 local-development mechanism only.
// It must NOT be used in production. Replace with Supabase Auth or an
// equivalent identity provider before any deployment beyond local dev.
export function authRouter(pool: DbClient): Router {
  const router = Router()

  // POST /auth/login  { email, password } → { token }
  router.post('/login', async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' })
      return
    }

    const secret = process.env.JWT_SECRET
    if (!secret) {
      res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' })
      return
    }

    try {
      const { rows } = await pool.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM local_users WHERE email = $1',
        [email],
      )
      const valid = rows.length > 0 && await bcrypt.compare(password, rows[0].password_hash)
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' })
        return
      }
      const token = jwt.sign({ sub: rows[0].id, email }, secret, { expiresIn: '24h' })
      res.json({ token })
    } catch (err) {
      console.error('[AUTH] /login error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /auth/me  → { userId, exporterId }
  router.get('/me', requireAuth(pool), (_req, res) => {
    res.json({ userId: res.locals.userId, exporterId: res.locals.exporterId })
  })

  return router
}
