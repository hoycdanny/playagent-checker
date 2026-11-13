import { describe, expect, test } from 'vitest';
import { LOCALES } from '../i18n/messages.ts';
import { guideContent } from './guideContent.ts';

// The deployment runs in us-west-2; the guide must not claim another region.
describe('guide text names the deployed region', () => {
  test.each(LOCALES)('%s guide mentions us-west-2 and never us-east-2', (locale) => {
    const text = JSON.stringify(guideContent(locale));
    expect(text).toContain('us-west-2');
    expect(text).not.toContain('us-east-2');
  });
});
