import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { ensureAuthenticated } from '../middleware/ensureAuth.js';

function createMocks(isAuthenticated: boolean) {
  const req = {
    isAuthenticated: vi.fn(() => isAuthenticated),
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('ensureAuthenticated', () => {
  it('calls next() when user is authenticated', () => {
    const { req, res, next } = createMocks(true);
    ensureAuthenticated(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when user is not authenticated', () => {
    const { req, res, next } = createMocks(false);
    ensureAuthenticated(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Authentication required. Use /api/auth/login to authenticate via SSO.',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
