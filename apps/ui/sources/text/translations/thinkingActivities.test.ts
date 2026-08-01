import { describe, expect, it } from 'vitest';

import { zhHans } from './zh-Hans';

describe('Chinese thinking activity translations', () => {
    it('keeps a broad set of distinct localized working states', () => {
        const activities = zhHans.status.thinkingActivities.split('|').map((value) => value.trim()).filter(Boolean);

        expect(activities.length).toBeGreaterThanOrEqual(50);
        expect(new Set(activities).size).toBeGreaterThanOrEqual(45);
        expect(activities.every((value) => /[\u3400-\u9fff]/u.test(value))).toBe(true);
    });
});
