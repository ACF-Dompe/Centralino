/**
 * Format seconds-remaining as the WLC dashboard expects:
 *  - "{days}g {hh}:{mm}:{ss}" when days > 0
 *  - "{hh}:{mm}:{ss}" otherwise
 *  - "Scaduto" when remaining <= 0
 */
export function formatRemaining(totalSeconds, elapsedSeconds, t) {
    const remaining = Math.max(0, totalSeconds - elapsedSeconds);
    if (remaining <= 0)
        return t('time.expired');
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = Math.floor(remaining % 60);
    const pad = (n) => String(n).padStart(2, '0');
    if (days > 0)
        return `${days}g ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
export function progressPercent(totalSeconds, elapsedSeconds) {
    if (totalSeconds <= 0)
        return 0;
    const remaining = Math.max(0, totalSeconds - elapsedSeconds);
    return Math.min(100, (remaining / totalSeconds) * 100);
}
//# sourceMappingURL=time.js.map