// Minimal stroke icons drawn for this plugin (same 1.5px stroke as the console's Lucide set).
import type { ReactElement } from "react";

const P = {
  play: <path d="M7 5v14l11-7z" />,
  pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
  prev: <><path d="M6 5v14" /><path d="M18 5 9 12l9 7z" /></>,
  next: <><path d="M18 5v14" /><path d="m6 5 9 7-9 7z" /></>,
  expand: <><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  record: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  compare: <><rect x="3" y="4" width="8" height="16" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /></>,
  map: <><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14" /><path d="M15 6v14" /></>,
  floor: <><path d="M3 20h18" /><path d="M5 20 8 8h8l3 12" /><path d="M12 8v12" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  link: <><path d="M14 4h6v6" /><path d="M10 14 20 4" /><path d="M20 14v6H4V4h6" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}
