/** Line art for empty states: a hanger on an empty rail. Decorative; inherits currentColor. */
export function HangerArt({ size = 56 }: { size?: number }) {
  return (
    <svg className="empty__art" width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <path d="M6 14h52" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path
        d="M32 14v4.5a4 4 0 1 0-4-4M32 22L9.5 38.5c-1.9 1.4-.9 4.5 1.5 4.5h42c2.4 0 3.4-3.1 1.5-4.5L32 22z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M20 52h24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}
