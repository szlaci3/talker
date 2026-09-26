export const COLOR_TARGETS = {
  pageBackground: 'Page background',
  headerBackground: 'Header background',
  messageBackground: 'Assistant message background',
  userMessageBackground: 'Your message background',
  composerBackground: 'Input background',
  primaryText: 'Main text',
  mutedText: 'Secondary text',
  accent: 'Icons and links',
  composerText: 'Input text',
} as const;

export type ColorTarget = keyof typeof COLOR_TARGETS;
export type ColorPreferences = Record<ColorTarget, string>;
export type Theme = 'system' | 'light' | 'dark';
export type UiAction =
  | { type: 'set_theme'; theme: Theme }
  | { type: 'set_font_scale'; scale: number }
  | { type: 'set_ui_color'; target: ColorTarget; color: string }
  | { type: 'reset_ui' }
  | { type: 'get_ui_preferences' };

export function initialTheme(): Theme {
  const saved = localStorage.getItem('theme');
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function initialScale(): number {
  const saved = Number(localStorage.getItem('scale') || 1);
  return Number.isFinite(saved) ? Math.max(.85, Math.min(1.3, saved)) : 1;
}

export const DEFAULT_COLORS: ColorPreferences = {
  pageBackground: '#f7f7f5',
  headerBackground: '#f7f7f5',
  messageBackground: '#f7f7f5',
  userMessageBackground: '#f7f7f5',
  composerBackground: '#ffffff',
  primaryText: '#292925',
  mutedText: '#777777',
  accent: '#398677',
  composerText: '#292925',
};

export const COLOR_CSS_VARIABLES: Record<ColorTarget, string> = {
  pageBackground: '--ui-page-bg',
  headerBackground: '--ui-header-bg',
  messageBackground: '--ui-message-bg',
  userMessageBackground: '--ui-user-message-bg',
  composerBackground: '--ui-composer-bg',
  primaryText: '--ui-primary-text',
  mutedText: '--ui-muted-text',
  accent: '--ui-accent',
  composerText: '--ui-composer-text',
};

export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const rgb = hex.slice(1).match(/.{2}/g)!.map(part => parseInt(part, 16) / 255).map(value =>
      value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    );
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

export function accessibleTextColor(requested: string, backgrounds: string[]): string {
  if (backgrounds.every(background => contrastRatio(requested, background) >= 4.5)) return requested;
  const rgb = requested.slice(1).match(/.{2}/g)!.map(part => parseInt(part, 16));
  const blend = (end: number[], amount: number) => '#' + rgb.map((start, index) =>
    Math.round(start + (end[index] - start) * amount).toString(16).padStart(2, '0')
  ).join('');
  const candidates = [[0, 0, 0], [255, 255, 255]].map(end => {
    let low = 0, high = 1;
    for (let i = 0; i < 24; i++) {
      const middle = (low + high) / 2;
      const candidate = blend(end, middle);
      if (backgrounds.every(background => contrastRatio(candidate, background) >= 4.5)) high = middle;
      else low = middle;
    }
    for (let amount = high; amount <= 1; amount += .002) {
      const candidate = blend(end, amount);
      if (backgrounds.every(background => contrastRatio(candidate, background) >= 4.5)) return candidate;
    }
    return blend(end, 1);
  });
  const readable = candidates.filter(candidate => backgrounds.every(background => contrastRatio(candidate, background) >= 4.5));
  return (readable.length ? readable : candidates).sort((a, b) => {
    const distance = (color: string) => color.slice(1).match(/.{2}/g)!.reduce((sum, part, index) => {
      const delta = parseInt(part, 16) - rgb[index];
      return sum + delta * delta;
    }, 0);
    return distance(a) - distance(b);
  })[0];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parseColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return '#' + color.slice(1).split('').map(char => char + char).join('').toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null;
}

export function validateUiAction(name: unknown, input: unknown): UiAction | null {
  if (!isRecord(input)) return null;
  if (name === 'set_theme' && Object.keys(input).length === 1 && ['system', 'light', 'dark'].includes(String(input.theme))) {
    return { type: 'set_theme', theme: input.theme as Theme };
  }
  if (name === 'set_font_scale' && Object.keys(input).length === 1 && typeof input.scale === 'number' && Number.isFinite(input.scale) && input.scale >= .85 && input.scale <= 1.3) {
    return { type: 'set_font_scale', scale: Math.round(input.scale * 100) / 100 };
  }
  if (name === 'set_ui_color' && Object.keys(input).length === 2 && typeof input.target === 'string' && input.target in COLOR_TARGETS) {
    const color = parseColor(input.color);
    return color ? { type: 'set_ui_color', target: input.target as ColorTarget, color } : null;
  }
  if (name === 'reset_ui' && Object.keys(input).length === 0) return { type: 'reset_ui' };
  if (name === 'get_ui_preferences' && Object.keys(input).length === 0) return { type: 'get_ui_preferences' };
  return null;
}

export function readSavedColors(): Partial<ColorPreferences> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('ui-colors') || '{}');
    if (!isRecord(saved)) return {};
    return Object.fromEntries(Object.keys(DEFAULT_COLORS).flatMap(target => {
      const color = parseColor(saved[target]);
      return color ? [[target, color]] : [];
    })) as Partial<ColorPreferences>;
  } catch {
    return {};
  }
}

export const UI_TOOL_DECLARATIONS = [
  {
    type: 'function', name: 'set_theme', description: 'Set the chat theme to light, dark, or system.',
    parameters: { type: 'object', properties: { theme: { type: 'string', enum: ['system', 'light', 'dark'] } }, required: ['theme'] },
  },
  {
    type: 'function', name: 'set_font_scale', description: 'Set chat text size from 0.85 (smaller) to 1.3 (larger), where 1 is the default.',
    parameters: { type: 'object', properties: { scale: { type: 'number', minimum: .85, maximum: 1.3 } }, required: ['scale'] },
  },
  {
    type: 'function', name: 'set_ui_color', description: 'Change one named chat UI color. Convert natural-language color requests to a six-digit hex color. For follow-up requests, adjust the same target and use the current preferences as context. Foreground text colors should remain readable against their backgrounds.',
    parameters: { type: 'object', properties: { target: { type: 'string', enum: Object.keys(COLOR_TARGETS) }, color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' } }, required: ['target', 'color'] },
  },
  {
    type: 'function', name: 'get_ui_preferences', description: 'Read the current theme, font size, and UI colors before making a contextual change.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'reset_ui', description: 'Reset the theme, font size, and all chat colors to their defaults.',
    parameters: { type: 'object', properties: {} },
  },
];
