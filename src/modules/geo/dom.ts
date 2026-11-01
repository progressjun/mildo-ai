/**
 * 브라우저용 제품페이지 추출기 — DOMParser로 PageFacts를 만든다 (스크립트는 실행되지 않음).
 * 판정은 engine.ts의 auditPage 하나로 한다. DOMParser가 없거나 실패하면 null → 호출부가 정규식 추출(extractPageFacts)로 대체.
 */
import { htmlToText, parseJsonLd, parsePrice, priceFactFrom, type PageFacts, type PriceFact } from './engine';

export function hasDomParser(): boolean {
  return typeof DOMParser !== 'undefined';
}

export function extractPageFactsDom(html: string): PageFacts | null {
  if (!hasDomParser()) return null;
  try {
    const src = String(html ?? '');
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const attrsOf = (el: Element): Record<string, string> => {
      const o: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) o[a.name.toLowerCase()] = a.value;
      return o;
    };
    const jsonLd = Array.from(doc.querySelectorAll('script')).filter((s) => (s.getAttribute('type') ?? '').toLowerCase().includes('ld+json')).map((s) => parseJsonLd(s.textContent ?? ''));
    const metas: PageFacts['metas'] = [];
    for (const m of Array.from(doc.querySelectorAll('meta'))) {
      const key = (m.getAttribute('name') ?? m.getAttribute('property') ?? m.getAttribute('itemprop') ?? '').toLowerCase();
      const content = m.getAttribute('content');
      if (key && content !== null) metas.push({ key, content });
    }
    const canonical = Array.from(doc.querySelectorAll('link')).find((l) => (l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'))?.getAttribute('href') ?? null;
    const images = Array.from(doc.querySelectorAll('img')).map((img) => ({ src: img.getAttribute('src') ?? img.getAttribute('data-src') ?? '', alt: img.hasAttribute('alt') ? img.getAttribute('alt') : null }));
    const body = doc.body;
    const h1 = body ? Array.from(body.querySelectorAll('h1')).map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim()) : [];
    const prices: PriceFact[] = [];
    if (body) {
      for (const el of Array.from(body.querySelectorAll('[itemprop], [data-price], [class*="price" i], [id*="price" i]'))) {
        const p = priceFactFrom(el.tagName, attrsOf(el), (el.textContent ?? '').replace(/\s+/g, ' ').trim());
        if (p) prices.push(p);
      }
    }
    for (const m of metas) if (m.key === 'price' || m.key === 'product:price:amount') {
      const v = parsePrice(m.content);
      if (v !== null && v >= 100) prices.push({ value: v, text: m.content, option: null, kind: 'price', source: 'itemprop' });
    }
    // 본문 텍스트: script · style 제거 후 (정규식 추출과 같은 정규화)
    const text = body ? htmlToText(body.innerHTML) : '';
    const title = doc.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() || null;
    return {
      parser: 'dom',
      title, metas, canonical,
      lang: doc.documentElement.getAttribute('lang'),
      h1, images, jsonLd, prices, text,
      bytes: src.length,
    };
  } catch {
    return null;
  }
}
