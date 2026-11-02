/** 커넥터 레지스트리 — provider → ConnectorDef. 공급자 파일은 각 도메인 담당이 채운다. */
import type { ConnectorDef, Provider } from './types';
import { connector as naverSa } from './naver-sa';
import { connector as googleAds } from './google-ads';
import { connector as meta } from './meta';
import { connector as kakaoMoment } from './kakao-moment';
import { connector as naverGfa } from './naver-gfa';
import { connector as naverCommerce } from './naver-commerce';
import { connector as coupang } from './coupang';
import { connector as cafe24 } from './cafe24';
import { connector as ohouse } from './ohouse';
import { connector as csv } from './csv';
import { connector as demo } from './demo';

export const CONNECTORS: Record<Provider, ConnectorDef> = {
  naver_sa: naverSa, google_ads: googleAds, meta, kakao_moment: kakaoMoment, naver_gfa: naverGfa,
  naver_commerce: naverCommerce, coupang, cafe24, ohouse, csv, demo,
};

export function getConnector(provider: string): ConnectorDef | null {
  return (CONNECTORS as Record<string, ConnectorDef>)[provider] ?? null;
}
