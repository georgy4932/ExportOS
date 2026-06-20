import type { Request, Response, NextFunction } from 'express'

declare global {
  namespace Express {
    interface Locals {
      exporterId: string
    }
  }
}

export function requireExporterId(req: Request, res: Response, next: NextFunction): void {
  const exporterId = req.headers['x-exporter-id']
  if (!exporterId || typeof exporterId !== 'string') {
    res.status(400).json({ error: 'X-Exporter-Id header is required' })
    return
  }
  res.locals.exporterId = exporterId
  next()
}
