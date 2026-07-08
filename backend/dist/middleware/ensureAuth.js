export function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({
        success: false,
        error: 'Authentication required. Use /api/auth/login to authenticate via SSO.',
    });
}
//# sourceMappingURL=ensureAuth.js.map