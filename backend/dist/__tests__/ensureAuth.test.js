import { describe, it, expect, vi } from 'vitest';
import { ensureAuthenticated } from '../middleware/ensureAuth.js';
function createMocks(isAuthenticated) {
    const req = {
        isAuthenticated: vi.fn(() => isAuthenticated),
    };
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
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
//# sourceMappingURL=ensureAuth.test.js.map