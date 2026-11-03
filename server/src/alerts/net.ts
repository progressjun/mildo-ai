/**
 * 외부 발송용 네트워크 — SSRF 방지(사설 · 루프백 · 링크 로컬 · 예약 주소 차단, https만) + 연결 시점 주소 검사가 붙은 HTTPS POST.
 *
 * 왜 fetch가 아니라 node:https인가: 이름 검사 후 fetch가 DNS를 다시 풀면 그 사이에 주소가 바뀔 수 있다(DNS rebinding).
 * https.request의 `lookup` 훅에서 실제로 연결할 주소를 검사하므로 검사한 주소와 연결한 주소가 같다.
 * 재시도는 잡 큐(notify.send)가 맡는다 — 여기서는 한 번만 보낸다. 테스트는 deps.poster에 가짜를 주입한다(실제 네트워크 금지).
 */
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
// IPv4 — RFC 6890 특수 용도 대역 (공인 인터넷이 아닌 곳)
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4');
// IPv6 — 미지정 · 루프백 · 고유 로컬 · 링크 로컬 · 사이트 로컬(폐기) · 멀티캐스트 · 문서용 · 6to4/Teredo(내부 주소를 감쌀 수 있음)
for (const [net, prefix] of [
  // ::/96 = 미지정 · 루프백 · IPv4 호환(폐기, ::a.b.c.d) 전부, 64:ff9b:1::/48 = 로컬 NAT64 (RFC 8215)
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2002::', 16], ['2001::', 32], ['100::', 64], ['64:ff9b:1::', 48],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6');

const BLOCKED_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.lan$/i, /\.home\.arpa$/i, /^metadata$/i, /^metadata\.google\.internal$/i];

/** IPv4-mapped(::ffff:a.b.c.d) · NAT64(64:ff9b::a.b.c.d) 안에 든 IPv4 */
function embeddedV4(v6: string): string | null {
  const s = v6.toLowerCase();
  const dotted = s.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = s.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** 공인 인터넷 주소가 아니면 true (발송 차단 대상) */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0];
  const fam = isIP(ip);
  if (fam === 4) return BLOCKED.check(ip, 'ipv4') || ip === '255.255.255.255';
  if (fam === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isBlockedAddress(v4);
    if (/^::ffff:/i.test(ip)) return true; // 해석하지 못한 매핑 주소는 막는다
    return BLOCKED.check(ip, 'ipv6');
  }
  return true; // IP가 아니면 주소로 쓸 수 없다
}

export interface UrlCheck { ok: boolean; reason?: string; url?: URL }

/**
 * 외부 발송 URL 정적 검사 (저장 · 발송 전): https만, 사용자 정보 금지, IP 리터럴은 공인 주소만, 내부용 이름 금지.
 * 이름(도메인)이 내부 주소로 풀리는 경우는 발송 시점 lookup 훅이 막는다.
 */
export function checkOutboundUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL 형식이 아닙니다' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https:// 주소만 쓸 수 있습니다 (암호화되지 않은 http는 차단)' };
  if (u.username || u.password) return { ok: false, reason: 'URL에 사용자 이름 · 비밀번호를 넣을 수 없습니다 (서명 비밀값을 쓰세요)' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: '호스트가 없습니다' };
  if (isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: '사설 · 루프백 · 링크 로컬 · 예약 주소로는 보낼 수 없습니다' };
  } else {
    if (BLOCKED_NAMES.some((re) => re.test(host))) return { ok: false, reason: '내부망 이름(localhost · .local · .internal 등)으로는 보낼 수 없습니다' };
    if (!host.includes('.')) return { ok: false, reason: '도메인 이름 전체(예: hooks.example.com)를 입력하세요' };
  }
  if (u.port && !/^\d+$/.test(u.port)) return { ok: false, reason: '포트 형식이 맞지 않습니다' };
  return { ok: true, url: u };
}

export interface PostResult { status: number; body: string; headers: Record<string, string> }
/** 외부 발송 포스터 — 테스트에서 가짜로 바꾼다 */
export type HttpPoster = (o: { url: string; body: string; headers: Record<string, string>; timeoutMs?: number }) => Promise<PostResult>;

export class OutboundBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundBlockedError';
  }
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 연결할 주소를 검사하는 lookup (https.request 옵션) */
export function guardedLookup(hostname: string, options: object, cb: LookupCb): void {
  dnsLookup(hostname, { ...(options as Record<string, unknown>), all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || !list.length) return cb(Object.assign(new OutboundBlockedError(`내부 주소로 풀리는 호스트라 발송을 막았습니다 (${hostname})`), { code: 'EBLOCKED' }), '');
    const all = (options as { all?: boolean }).all;
    if (all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const MAX_RESPONSE = 64 * 1024;

type RequestImpl = typeof httpsRequest;

/**
 * 포스터 만들기 (테스트는 requestImpl에 가짜를 넣어 시간 초과 · 큰 응답 처리를 확인한다).
 * 제한: 소켓 유휴 timeoutMs + 전체 마감 timeoutMs × 1.5(느리게 조금씩 보내는 응답이 워커를 붙잡지 못하게) · 응답 64KB(넘으면 끊고 앞부분만) · 리다이렉트 따라가지 않음.
 */
export function createHttpsPoster(requestImpl: RequestImpl = httpsRequest): HttpPoster {
  return ({ url, body, headers, timeoutMs = 10_000 }) =>
    new Promise((resolve, reject) => {
      const chk = checkOutboundUrl(url);
      if (!chk.ok || !chk.url) return reject(new OutboundBlockedError(chk.reason ?? '발송할 수 없는 주소입니다'));
      // 테스트 중 실네트워크 금지 (docs/SAAS_SPEC.md §5) — 테스트는 deps.poster에 가짜를 주입한다
      if (requestImpl === httpsRequest && process.env.NODE_ENV === 'test' && process.env.ALLOW_TEST_NETWORK !== 'true') {
        return reject(new Error('테스트 환경에서는 실제 발송을 하지 않습니다 (setAlertDepsForTest로 가짜 poster 주입)'));
      }
      const u = chk.url;
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); fn(); } };
      const req = requestImpl(
        {
          protocol: 'https:',
          hostname: u.hostname.replace(/^\[|\]$/g, ''),
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'MILDO-OS-Notify/1.0', ...headers, 'content-length': Buffer.byteLength(body) },
          lookup: guardedLookup as never,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () => {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers ?? {})) if (typeof v === 'string') h[k] = v;
            done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: h }));
          };
          res.on('data', (c: Buffer) => {
            if (settled) return;
            size += c.length;
            if (size <= MAX_RESPONSE) chunks.push(c);
            else { finish(); res.destroy?.(); }
          });
          res.on('end', finish);
          res.on('error', (e: Error) => done(() => reject(e)));
        },
      );
      const deadline = setTimeout(() => {
        const e = new Error(`응답 시간 초과 (전체 ${Math.round((timeoutMs * 1.5) / 1000)}초)`);
        done(() => reject(e));
        req.destroy(e);
      }, Math.round(timeoutMs * 1.5));
      req.on('timeout', () => req.destroy(new Error(`응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`)));
      req.on('error', (e: Error) => done(() => reject(e)));
      req.end(body);
    });
}

/** 기본 포스터: node:https + 연결 시점 주소 검사 */
export const httpsPoster: HttpPoster = createHttpsPoster();
