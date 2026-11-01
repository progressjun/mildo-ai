/* 스트로크 아이콘 세트 (24 그리드, currentColor) */
const PATHS: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  bot: 'M12 3v3M7 8h10a3 3 0 013 3v6a3 3 0 01-3 3H7a3 3 0 01-3-3v-6a3 3 0 013-3zM9 13h.01M15 13h.01M9 17h6',
  board: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  pilot: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z',
  report: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  watch: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  lab: 'M9 3h6M10 3v6L4 19a1.5 1.5 0 001.3 2h13.4A1.5 1.5 0 0020 19l-6-10V3M7 15h10',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  flow: 'M5 6a2 2 0 100-4 2 2 0 000 4zM19 22a2 2 0 100-4 2 2 0 000 4zM5 6v6a4 4 0 004 4h6a4 4 0 014 4M19 2v4M17 4h4',
  bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  stop: 'M5 5h14v14H5z',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  external: 'M14 3h7v7M10 14L21 3M19 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  rollback: 'M3 7v6h6M3 13a9 9 0 103-7.7L3 7',
  shield: 'M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z',
  wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 14h.01',
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
  target: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
  link: 'M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
  filter: 'M3 4h18l-7 9v6l-4 2v-8z',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  zap: 'M13 2L3 14h8l-1 8 10-12h-8z',
};

export function Icon({ name, size = 16, stroke = 1.8, className, title }: { name: keyof typeof PATHS | string; size?: number; stroke?: number; className?: string; title?: string }) {
  const d = PATHS[name] ?? PATHS.sparkle;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
