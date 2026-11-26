import { describe, expect, it } from 'vitest';
import { classifyResponse, classifyThrown } from '../src/classify.ts';

const r = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, body, headers });

describe('classifyResponse', () => {
  it('treats 429, 403 and 428 as Blocked', () => {
    expect(classifyResponse(r(429))).toBe('Blocked');
    expect(classifyResponse(r(403, 'Access Denied ... Reference #18.abc'))).toBe('Blocked');
    expect(classifyResponse(r(428))).toBe('Blocked');
  });
  it('treats a challenge page as Blocked whatever its status', () => {
    expect(classifyResponse(r(200, '<script src="/_sec/cp_challenge/ak-challenge.js">'))).toBe('Blocked');
    expect(classifyResponse(r(302, '', { Location: 'https://www.airbnb.com/_sec/cp_challenge/x' }))).toBe('Blocked');
  });
  it('sorts the rest', () => {
    expect(classifyResponse(r(503))).toBe('Transient');
    expect(classifyResponse(r(400))).toBe('RequestRejected');
    expect(classifyResponse(r(200, '{}'))).toBeNull();
  });
  it('treats timeouts and network errors as transient', () => {
    const e = new Error('ReadTimeout');
    expect(classifyThrown(e)).toBe('Transient');
    expect(classifyThrown(new Error('weird'))).toBe('Unknown');
  });
});
