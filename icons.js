"use strict";

/* ---------- Interface icons (inline SVG, lucide-style strokes) ---------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" fill="currentColor" stroke="none"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 10v10M8 13H3M21 13h-5M5 7l3 2M19 7l-3 2M5 20l3-3M19 20l-3-3M9.5 6 8 3M14.5 6 16 3"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  folderPlus: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M12 10v6M9 13h6"/>',
  file: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3v5.5h-5.5"/>',
  checkBig: '<path d="m5 12 5 5 9-10"/>',
  checkSmall: '<path d="m6 12 4 4 8-8"/>',
  circleCheck: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.5 12 3 3 6-6" stroke="var(--panel)"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowsUpDown: '<path d="M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  userPlus: '<circle cx="10" cy="8" r="4"/><path d="M2 21a8 8 0 0 1 13-6.2M19 14v6M16 17h6"/>',
  userMinus: '<circle cx="10" cy="8" r="4"/><path d="M2 21a8 8 0 0 1 13-6.2M16 17h6"/>',
  userX: '<circle cx="10" cy="8" r="4"/><path d="M2 21a8 8 0 0 1 13-6.2M16.5 14.5l5 5M21.5 14.5l-5 5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a7 7 0 0 1 4 6.5"/>',
  chevronsUp: '<path d="m7 11 5-5 5 5M7 18l5-5 5 5"/>',
  chevronsDown: '<path d="m7 6 5 5 5-5M7 13l5 5 5-5"/>',
  minus: '<path d="M5 12h14"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  spinner: '<path d="M12 4a8 8 0 1 1-7.4 5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  images: '<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12M7 13l4-4 6 6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  paperclip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10 17.3a1.7 1.7 0 0 1-2.3-2.3L15.5 7"/>',
  bold: '<path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  strike: '<path d="M16 6a4 4 0 0 0-4-2c-2.5 0-4 1.4-4 3.3 0 1.2.6 2 1.6 2.7M4 12h16M8 18a4 4 0 0 0 4 2c2.5 0 4-1.4 4-3.3 0-.6-.1-1.1-.4-1.6"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  quote: '<path d="M4 6h16M8 12h12M8 18h12M4 12v6"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1-4 4.5-8.5 13-9-0.5 8.5-5 12-9 13z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  gif: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 10H8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2v-2M13 10v4M16.5 14v-4H19M16.5 12h2"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.7-9.95A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  cloudOff: '<path d="M7 18a5 5 0 0 1-.7-9.95M10 6.3A6 6 0 0 1 18 9a4.5 4.5 0 0 1 2.4 8.3M3 3l18 18"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z"/>',
  gamepad: '<path d="M6 8h12a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.6A3.5 3.5 0 0 1 2 13.5V12a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3M16 11.5h.01M18 13h.01"/>',
};

function icon(name, size = 20, sw = 1.8) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/* ---------- Platforms ---------- */
// Simple glyphs that suggest each platform; filled shapes use currentColor.
const PLATFORMS = {
  roblox: { label: "Roblox", svg: '<path fill="currentColor" fill-rule="evenodd" d="M6.2 2.5 21.5 6.2 17.8 21.5 2.5 17.8ZM10.6 9.3 9.6 13.4 13.7 14.4 14.7 10.3Z"/>' },
  pc: { label: "PC", svg: '<path fill="currentColor" d="M3 5.5 10.5 4.4v7.1H3zM11.7 4.2 21 3v8.5h-9.3zM3 12.7h7.5v7.1L3 18.6zM11.7 12.7H21V21l-9.3-1.3z"/>' },
  mac: { label: "Mac", svg: '<path fill="currentColor" d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8C6.9 7.4 5.4 8.3 4.6 9.8c-1.7 2.9-.4 7.2 1.2 9.6.8 1.2 1.7 2.4 3 2.4 1.2 0 1.6-.8 3.1-.8s1.9.8 3.1.8c1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.8-1-2.8-4.2zM14.1 5.8c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"/>' },
  linux: { label: "Linux", svg: '<rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7 9 3 3-3 3M12 15h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' },
  ios: { label: "iOS", svg: '<rect x="6" y="2.5" width="12" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  android: { label: "Android", svg: '<path fill="currentColor" d="M6 10h12v7.5a1.5 1.5 0 0 1-1.5 1.5H15v2.5a1 1 0 0 1-2 0V19h-2v2.5a1 1 0 0 1-2 0V19H7.5A1.5 1.5 0 0 1 6 17.5zM6.2 9a5.8 5.8 0 0 1 11.6 0zM3.5 10.5a1 1 0 0 1 2 0v5a1 1 0 0 1-2 0zM18.5 10.5a1 1 0 0 1 2 0v5a1 1 0 0 1-2 0z"/><path d="m8 3.5 1.3 2M16 3.5l-1.3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
  mobile: { label: "Mobile", svg: '<rect x="6" y="2.5" width="12" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  web: { label: "Web", svg: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/>' },
  playstation: { label: "PlayStation", svg: '<path d="m7 3.5 3 5H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="17" cy="6.5" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m4.5 14.5 5 5M9.5 14.5l-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><rect x="14" y="14" width="6" height="6" rx=".8" fill="none" stroke="currentColor" stroke-width="1.7"/>' },
  xbox: { label: "Xbox", svg: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.5 6.5c3 2 6 5.5 8.5 11M16.5 6.5c-3 2-6 5.5-8.5 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  switch: { label: "Switch", svg: '<path fill="currentColor" d="M10.5 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h3z"/><path d="M13.5 3h3A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-3z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="7" cy="8" r="1.4" fill="var(--panel)"/><circle cx="17" cy="15" r="1.4" fill="currentColor"/>' },
  steam: { label: "Steam", svg: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="15" cy="9.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="15" r="2" fill="currentColor"/><path d="m10.5 13.8 2.6-2.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  vr: { label: "VR", svg: '<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4l-1.5-2.5h-3L9 17H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' },
  console: { label: "Console", svg: ICONS.gamepad.replace(/<path /g, '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ') },
};
const PLATFORM_ALIASES = {
  windows: "pc", computer: "pc", desktop: "pc", macos: "mac", osx: "mac", apple: "mac",
  iphone: "ios", ipad: "ios", phone: "mobile", browser: "web", html5: "web",
  ps4: "playstation", ps5: "playstation", ps: "playstation", nintendo: "switch",
  quest: "vr", "meta quest": "vr", oculus: "vr",
};
function platformKey(name) {
  const k = String(name || "").trim().toLowerCase();
  return PLATFORMS[k] ? k : PLATFORM_ALIASES[k] || null;
}
function platformLabel(name) {
  const k = platformKey(name);
  return k ? PLATFORMS[k].label : String(name || "").trim();
}
function platformIcon(name, size = 16) {
  const k = platformKey(name);
  const svg = k ? PLATFORMS[k].svg : PLATFORMS.console.svg;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`;
}
