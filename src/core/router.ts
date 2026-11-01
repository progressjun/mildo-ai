import { useEffect, useState } from 'react';

/** 해시 라우팅 — 아티팩트 규칙상 plain #name 만 사용 */
export function currentRoute(): string {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  return /^[a-z0-9-]+$/.test(h) ? h : 'home';
}

export function navigate(route: string) {
  if (currentRoute() === route) return;
  location.hash = route;
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
