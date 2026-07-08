/**
 * Express middleware that rejects unauthenticated requests with 401.
 * Must be used AFTER session and passport.initialize()/session().
 */
import type { Request, Response, NextFunction } from 'express';

export function ensureAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({
    success: false,
    error: 'Authentication required. Use /api/auth/login to authenticate via SSO.',
  });
}
