/**
 * Credential generation for guest accounts.
 *  - username = "g.{slug}{3 digits}"
 *  - password = "DOMPE-{4 digits}"
 */
export function generateCredentials(rawName) {
    const slug = rawName
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .slice(0, 8);
    const safeSlug = slug.length > 0 ? slug : 'guest';
    const num = randomInt(100, 999);
    const pin = randomInt(1000, 9999);
    return {
        username: `g.${safeSlug}${num}`,
        password: `DOMPE-${pin}`,
    };
}
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
//# sourceMappingURL=credentials.js.map