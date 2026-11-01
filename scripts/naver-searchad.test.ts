import { describe, expect, it } from 'vitest';
import { authHeaders, parseVolume, sign } from './naver-searchad';
import { createHmac } from 'node:crypto';

describe('naver searchad signature', () => {
  it('signs timestamp.METHOD.path with HMAC-SHA256 base64', () => {
    const expected = createHmac('sha256', 'secret').update('1700000000000.GET./ncc/campaigns').digest('base64');
    expect(sign('secret', '1700000000000', 'get', '/ncc/campaigns')).toBe(expected);
  });
  it('builds all auth headers', () => {
    const h = authHeaders({ apiKey: 'k', secret: 's', customerId: '123' }, 'GET', '/billing/bizmoney', 1700000000000);
    expect(h['X-Timestamp']).toBe('1700000000000');
    expect(h['X-API-KEY']).toBe('k');
    expect(h['X-Customer']).toBe('123');
    expect(h['X-Signature']).toBe(sign('s', '1700000000000', 'GET', '/billing/bizmoney'));
  });
  it('parses volume strings', () => {
    expect(parseVolume('< 10')).toBe(10);
    expect(parseVolume(1200)).toBe(1200);
    expect(parseVolume('abc')).toBe(0);
  });
});
