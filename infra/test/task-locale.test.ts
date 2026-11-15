import { describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { createJob, validateSubmit } from '../lambda/api/tasks.js';

const base = { backend: 'web', appId: 'app1', caseId: 'case1' };

async function stored(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let written = '';
  const s3 = {
    send: async (cmd: { input: { Body?: string } }) => {
      written = String(cmd.input.Body);
      return {};
    },
  } as unknown as S3Client;
  await createJob(s3, 'bucket', 'tenant', validateSubmit(body));
  return JSON.parse(written) as Record<string, unknown>;
}

describe('task locale', () => {
  it('stores a valid locale in job.json', async () => {
    expect((await stored({ ...base, locale: 'ja' }))['locale']).toBe('ja');
  });

  it('stores no locale key when absent', async () => {
    expect('locale' in (await stored(base))).toBe(false);
  });

  it('stores no locale key for an invalid value', async () => {
    expect('locale' in (await stored({ ...base, locale: 'xx' }))).toBe(false);
    expect('locale' in (await stored({ ...base, locale: 'zh' }))).toBe(false);
  });
});
