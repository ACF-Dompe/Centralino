import { describe, it, expect } from 'vitest';
import { router } from '../routes/index.js';
describe('routes', () => {
    it('exports a router', () => {
        expect(router).toBeDefined();
        expect(router.stack).toBeInstanceOf(Array);
    });
    it('has at least one middleware layer (routes)', () => {
        expect(router.stack.length).toBeGreaterThan(0);
    });
    it('has the health route registered (should be public)', () => {
        const healthLayer = router.stack.find((layer) => {
            const routePath = layer.route?.path ?? layer.name ?? '';
            return routePath === '/health' || layer.regexp?.source?.includes('/health');
        });
        expect(healthLayer).toBeDefined();
    });
});
//# sourceMappingURL=routes.test.js.map