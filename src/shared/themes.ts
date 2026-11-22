/**
 * The app's color themes.
 *
 * A theme is two independent choices:
 *
 * - the **mode** — System, Light or Dark — persisted as `AppSettings.theme`, and
 * - the **palette** — one of the twenty color families below — persisted as `AppSettings.palette`.
 *
 * Every palette ships a light and a dark variant, so the mode survives any palette switch and
 * System can follow the OS in every family. Palettes are data: the renderer's custom properties
 * (emitted by {@link themeCss}), the native window chrome and the terminal's ANSI palette all read
 * the same numbers.
 *
 * The variants were derived in OKLCH from one recipe, so every family has the same reading
 * comfort: off-white/off-black text at roughly 13–15:1 rather than pure white on black, softly
 * tinted (never saturated) surfaces, accents and status hues that stay at or above WCAG AA as
 * text, and status hues on fixed anchors so green, amber and red mean the same thing in every
 * theme. `tests/themes.test.ts` holds every variant to that bar.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

/** A mode resolved against the OS: what the window actually paints. */
export type ColorScheme = 'light' | 'dark';

export type PaletteId =
  | 'default'
  | 'graphite'
  | 'slate'
  | 'stone'
  | 'midnight'
  | 'abyss'
  | 'fjord'
  | 'admiral'
  | 'evergreen'
  | 'meadow'
  | 'lagoon'
  | 'citrine'
  | 'ember'
  | 'cappuccino'
  | 'solarium'
  | 'claret'
  | 'ultraviolet'
  | 'blossom'
  | 'dusk'
  | 'nebula';

export type PaletteGroup = 'neutral' | 'cool' | 'nature' | 'warm' | 'vivid';

/** Every color token a variant must define. Keys map to `--kebab-case` custom properties. */
export interface ThemePalette {
  bg: string;
  bgElev: string;
  bgSunken: string;
  bgHover: string;
  bgActive: string;
  fg: string;
  fgMuted: string;
  fgFaint: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentFg: string;
  green: string;
  amber: string;
  red: string;
  blue: string;
  purple: string;
  cyan: string;
  userBubble: string;
  shadow: string;
}

export interface PaletteDescriptor {
  id: PaletteId;
  name: string;
  group: PaletteGroup;
  description: string;
  /** True for palettes that add motion; all of it is disabled under `prefers-reduced-motion`. */
  animated?: boolean;
  light: ThemePalette;
  dark: ThemePalette;
}

export interface ThemeModeDescriptor {
  id: ThemeMode;
  name: string;
  description: string;
}

/** Caption colors for the frameless title bar: the variant's `--bg-elev` / `--fg`. */
export interface ThemeChrome {
  color: string;
  symbolColor: string;
}

export const DEFAULT_THEME_MODE: ThemeMode = 'system';
export const DEFAULT_PALETTE: PaletteId = 'default';

export const THEME_MODES: ThemeModeDescriptor[] = [
  { id: 'system', name: 'System', description: 'Follow your computer’s light or dark setting.' },
  { id: 'light', name: 'Light', description: 'Always use the light variant of the palette.' },
  { id: 'dark', name: 'Dark', description: 'Always use the dark variant of the palette.' }
];

export const PALETTES: PaletteDescriptor[] = [
  {
    id: 'default',
    name: 'Default',
    group: 'neutral',
    description: 'The signature Vocs palette: neutral grays with an indigo accent.',
    light: {
      bg: '#f7f7f8',
      bgElev: '#ffffff',
      bgSunken: '#efeff1',
      bgHover: 'rgba(0, 0, 0, 0.045)',
      bgActive: 'rgba(0, 0, 0, 0.08)',
      fg: '#1c1c1f',
      fgMuted: '#62666d',
      fgFaint: '#8a8e96',
      border: '#e3e4e8',
      borderStrong: '#cfd1d6',
      accent: '#5b5bd6',
      accentFg: '#ffffff',
      green: '#157c45',
      amber: '#9c600a',
      red: '#c8302f',
      blue: '#2a64d6',
      purple: '#8247c8',
      cyan: '#0c7885',
      userBubble: '#e9e9fb',
      shadow: '0 8px 30px rgba(0, 0, 0, 0.14)'
    },
    dark: {
      bg: '#111318',
      bgElev: '#191c23',
      bgSunken: '#0d0f13',
      bgHover: 'rgba(255, 255, 255, 0.06)',
      bgActive: 'rgba(255, 255, 255, 0.1)',
      fg: '#e6e7ea',
      fgMuted: '#9aa0aa',
      fgFaint: '#6b7280',
      border: '#262a33',
      borderStrong: '#363b47',
      accent: '#8b8bff',
      accentFg: '#0e0e1a',
      green: '#3ecf7a',
      amber: '#f0b44c',
      red: '#ff6b6e',
      blue: '#6ea0ff',
      purple: '#c084fc',
      cyan: '#4dd0e1',
      userBubble: '#23263a',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    group: 'neutral',
    description: 'Pure grayscale chrome; color only where it carries meaning.',
    light: {
      bg: '#f8f8f8',
      bgElev: '#fdfdfd',
      bgSunken: '#f0f0f0',
      bgHover: 'rgba(35, 35, 35, 0.05)',
      bgActive: 'rgba(35, 35, 35, 0.085)',
      fg: '#232323',
      fgMuted: '#696063',
      fgFaint: '#90888a',
      border: '#dfdfdf',
      borderStrong: '#cccccc',
      accent: '#333333',
      accentFg: '#fafcff',
      green: '#2c7f44',
      amber: '#8e6201',
      red: '#a64c47',
      blue: '#376daf',
      purple: '#7e55a8',
      cyan: '#037a84',
      userBubble: '#fde6ec',
      shadow: '0 8px 30px rgba(34, 34, 34, 0.14)'
    },
    dark: {
      bg: '#191919',
      bgElev: '#222222',
      bgSunken: '#131313',
      bgHover: 'rgba(227, 227, 227, 0.06)',
      bgActive: 'rgba(227, 227, 227, 0.1)',
      fg: '#e3e3e3',
      fgMuted: '#ada8a9',
      fgFaint: '#7c7779',
      border: '#2f2f2f',
      borderStrong: '#414141',
      accent: '#d1d1d1',
      accentFg: '#161616',
      green: '#86c894',
      amber: '#dbad65',
      red: '#ef9d95',
      blue: '#8ab9f5',
      purple: '#c6a4ee',
      cyan: '#5cc8d4',
      userBubble: '#372329',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'slate',
    name: 'Slate',
    group: 'neutral',
    description: 'Cool blue-gray surfaces with a dusty periwinkle accent.',
    light: {
      bg: '#f3f8ff',
      bgElev: '#fcfdff',
      bgSunken: '#eaf1fa',
      bgHover: 'rgba(29, 35, 44, 0.05)',
      bgActive: 'rgba(29, 35, 44, 0.085)',
      fg: '#1d232c',
      fgMuted: '#566578',
      fgFaint: '#7d8c9f',
      border: '#d9e0ea',
      borderStrong: '#c5cdd7',
      accent: '#536091',
      accentFg: '#fbfcff',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#e6ecff',
      shadow: '0 8px 30px rgba(26, 34, 45, 0.14)'
    },
    dark: {
      bg: '#151a21',
      bgElev: '#1d232a',
      bgSunken: '#0f141a',
      bgHover: 'rgba(223, 227, 232, 0.06)',
      bgActive: 'rgba(223, 227, 232, 0.1)',
      fg: '#dfe3e8',
      fgMuted: '#a1aab6',
      fgFaint: '#717a85',
      border: '#293038',
      borderStrong: '#3b424a',
      accent: '#a1b0d8',
      accentFg: '#111621',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#232a3a',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'stone',
    name: 'Stone',
    group: 'neutral',
    description: 'Warm putty grays with a terracotta accent.',
    light: {
      bg: '#fdf7ef',
      bgElev: '#fefdfc',
      bgSunken: '#f6efe6',
      bgHover: 'rgba(41, 33, 25, 0.05)',
      bgActive: 'rgba(41, 33, 25, 0.085)',
      fg: '#292119',
      fgMuted: '#71604d',
      fgFaint: '#988775',
      border: '#e7ded5',
      borderStrong: '#d3cac1',
      accent: '#994832',
      accentFg: '#fefbfa',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#fee7e1',
      shadow: '0 8px 30px rgba(41, 32, 21, 0.14)'
    },
    dark: {
      bg: '#1c1915',
      bgElev: '#25211d',
      bgSunken: '#16130f',
      bgHover: 'rgba(229, 226, 223, 0.06)',
      bgActive: 'rgba(229, 226, 223, 0.1)',
      fg: '#e5e2df',
      fgMuted: '#b0a89f',
      fgFaint: '#7f7770',
      border: '#332e29',
      borderStrong: '#45403b',
      accent: '#d98f7b',
      accentFg: '#250f09',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#38241f',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    group: 'cool',
    description: 'Calm navy with a clear azure accent.',
    light: {
      bg: '#f4f8ff',
      bgElev: '#fdfdfe',
      bgSunken: '#e9f1fd',
      bgHover: 'rgba(28, 35, 47, 0.05)',
      bgActive: 'rgba(28, 35, 47, 0.085)',
      fg: '#1c232f',
      fgMuted: '#57647b',
      fgFaint: '#7f8ba0',
      border: '#d8e0ee',
      borderStrong: '#c4cddb',
      accent: '#006ebe',
      accentFg: '#fafcfe',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#e0effe',
      shadow: '0 8px 30px rgba(25, 34, 49, 0.14)'
    },
    dark: {
      bg: '#10192a',
      bgElev: '#192233',
      bgSunken: '#0b1323',
      bgHover: 'rgba(223, 227, 235, 0.06)',
      bgActive: 'rgba(223, 227, 235, 0.1)',
      fg: '#dfe3eb',
      fgMuted: '#9daac0',
      fgFaint: '#6e798e',
      border: '#252f42',
      borderStrong: '#364155',
      accent: '#73b6fa',
      accentFg: '#03172b',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#172c40',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'abyss',
    name: 'Abyss',
    group: 'cool',
    description: 'Deep ocean blue with an aqua accent.',
    light: {
      bg: '#f0f9ff',
      bgElev: '#fcfeff',
      bgSunken: '#e6f2f9',
      bgHover: 'rgba(24, 37, 44, 0.05)',
      bgActive: 'rgba(24, 37, 44, 0.085)',
      fg: '#18252c',
      fgMuted: '#4c6876',
      fgFaint: '#768f9d',
      border: '#d4e2ea',
      borderStrong: '#c0cfd7',
      accent: '#067461',
      accentFg: '#f8fdfb',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#daf3ec',
      shadow: '0 8px 30px rgba(19, 36, 45, 0.14)'
    },
    dark: {
      bg: '#0a1c25',
      bgElev: '#12252e',
      bgSunken: '#04161e',
      bgHover: 'rgba(219, 229, 234, 0.06)',
      bgActive: 'rgba(219, 229, 234, 0.1)',
      fg: '#dbe5ea',
      fgMuted: '#95adbb',
      fgFaint: '#667d89',
      border: '#1e323c',
      borderStrong: '#30444f',
      accent: '#57c8ae',
      accentFg: '#001b15',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#0f3129',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'fjord',
    name: 'Fjord',
    group: 'cool',
    description: 'Nordic slate-blue with a soft frost accent.',
    light: {
      bg: '#eaf2f8',
      bgElev: '#f7fafc',
      bgSunken: '#e1eaf1',
      bgHover: 'rgba(26, 36, 43, 0.05)',
      bgActive: 'rgba(26, 36, 43, 0.085)',
      fg: '#1a242b',
      fgMuted: '#516676',
      fgFaint: '#768b9a',
      border: '#d0dae2',
      borderStrong: '#bcc7cf',
      accent: '#327382',
      accentFg: '#f7fdfe',
      green: '#0a7e3a',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#daf2f8',
      shadow: '0 8px 30px rgba(23, 35, 44, 0.14)'
    },
    dark: {
      bg: '#16232c',
      bgElev: '#1f2c36',
      bgSunken: '#101d26',
      bgHover: 'rgba(220, 228, 234, 0.06)',
      bgActive: 'rgba(220, 228, 234, 0.1)',
      fg: '#dce4ea',
      fgMuted: '#9aacba',
      fgFaint: '#6a7b88',
      border: '#2c3a44',
      borderStrong: '#3e4d57',
      accent: '#88bace',
      accentFg: '#09181e',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#1d3741',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'admiral',
    name: 'Admiral',
    group: 'cool',
    description: 'Navy hull, parchment text and brass fittings.',
    light: {
      bg: '#f5f8ff',
      bgElev: '#fdfdfe',
      bgSunken: '#ebf0fb',
      bgHover: 'rgba(39, 34, 24, 0.05)',
      bgActive: 'rgba(39, 34, 24, 0.085)',
      fg: '#272218',
      fgMuted: '#58637b',
      fgFaint: '#818ba1',
      border: '#dae0ec',
      borderStrong: '#c6ccd9',
      accent: '#815c0a',
      accentFg: '#fefbf7',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#e5edff',
      shadow: '0 8px 30px rgba(27, 33, 47, 0.14)'
    },
    dark: {
      bg: '#11192b',
      bgElev: '#192235',
      bgSunken: '#0b1324',
      bgHover: 'rgba(233, 226, 212, 0.06)',
      bgActive: 'rgba(233, 226, 212, 0.1)',
      fg: '#e9e2d4',
      fgMuted: '#9fa9c0',
      fgFaint: '#6f798e',
      border: '#262f43',
      borderStrong: '#374157',
      accent: '#d3aa64',
      accentFg: '#1f1401',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#1e2943',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'evergreen',
    name: 'Evergreen',
    group: 'nature',
    description: 'Pine-forest greens with a jade accent.',
    light: {
      bg: '#eefbf5',
      bgElev: '#fafffc',
      bgSunken: '#e5f4ed',
      bgHover: 'rgba(23, 39, 32, 0.05)',
      bgActive: 'rgba(23, 39, 32, 0.085)',
      fg: '#172720',
      fgMuted: '#4e6b5e',
      fgFaint: '#789285',
      border: '#d4e4dc',
      borderStrong: '#bfd1c8',
      accent: '#008053',
      accentFg: '#f8fdfa',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#ddf3e6',
      shadow: '0 8px 30px rgba(18, 39, 30, 0.14)'
    },
    dark: {
      bg: '#0f1d17',
      bgElev: '#18261f',
      bgSunken: '#091611',
      bgHover: 'rgba(221, 229, 225, 0.06)',
      bgActive: 'rgba(221, 229, 225, 0.1)',
      fg: '#dde5e1',
      fgMuted: '#9bafa5',
      fgFaint: '#6b7e75',
      border: '#24332c',
      borderStrong: '#36453e',
      accent: '#6dc799',
      accentFg: '#011c0f',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#1a2f24',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'meadow',
    name: 'Meadow',
    group: 'nature',
    description: 'Soft sage with a fresh leaf-green accent.',
    light: {
      bg: '#f5faed',
      bgElev: '#fcfefa',
      bgSunken: '#edf3e4',
      bgHover: 'rgba(32, 37, 24, 0.05)',
      bgActive: 'rgba(32, 37, 24, 0.085)',
      fg: '#202518',
      fgMuted: '#5e684f',
      fgFaint: '#868f78',
      border: '#dce3d2',
      borderStrong: '#c8cfbe',
      accent: '#487c25',
      accentFg: '#fafdf9',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#e4f2dd',
      shadow: '0 8px 30px rgba(30, 37, 17, 0.14)'
    },
    dark: {
      bg: '#181b13',
      bgElev: '#20241b',
      bgSunken: '#12150d',
      bgHover: 'rgba(226, 228, 222, 0.06)',
      bgActive: 'rgba(226, 228, 222, 0.1)',
      fg: '#e2e4de',
      fgMuted: '#a6ac9e',
      fgFaint: '#767b6e',
      border: '#2d3127',
      borderStrong: '#3f4339',
      accent: '#90c273',
      accentFg: '#0c1b04',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#232e1e',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    group: 'nature',
    description: 'Tropical teal water with a coral accent.',
    light: {
      bg: '#ecfbfd',
      bgElev: '#fbfeff',
      bgSunken: '#e3f4f6',
      bgHover: 'rgba(20, 38, 41, 0.05)',
      bgActive: 'rgba(20, 38, 41, 0.085)',
      fg: '#142629',
      fgMuted: '#486a6e',
      fgFaint: '#729195',
      border: '#d1e4e6',
      borderStrong: '#bcd1d3',
      accent: '#ae443f',
      accentFg: '#fefbfa',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#d7f3f6',
      shadow: '0 8px 30px rgba(12, 38, 41, 0.14)'
    },
    dark: {
      bg: '#071d20',
      bgElev: '#102628',
      bgSunken: '#031719',
      bgHover: 'rgba(218, 229, 231, 0.06)',
      bgActive: 'rgba(218, 229, 231, 0.1)',
      fg: '#dae5e7',
      fgMuted: '#93afb3',
      fgFaint: '#647f82',
      border: '#1c3336',
      borderStrong: '#2e4648',
      accent: '#fb988f',
      accentFg: '#280c0a',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#0d3033',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'citrine',
    name: 'Citrine',
    group: 'nature',
    description: 'Olive-tinted neutrals with a citron accent.',
    light: {
      bg: '#fbf8e9',
      bgElev: '#fefef8',
      bgSunken: '#f3f1e0',
      bgHover: 'rgba(38, 35, 21, 0.05)',
      bgActive: 'rgba(38, 35, 21, 0.085)',
      fg: '#262315',
      fgMuted: '#68644a',
      fgFaint: '#8f8c73',
      border: '#e3e0cd',
      borderStrong: '#d0cdb8',
      accent: '#6d6600',
      accentFg: '#fcfcf7',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#f0efd5',
      shadow: '0 8px 30px rgba(38, 34, 9, 0.14)'
    },
    dark: {
      bg: '#1b1a12',
      bgElev: '#24221b',
      bgSunken: '#15140c',
      bgHover: 'rgba(228, 227, 222, 0.06)',
      bgActive: 'rgba(228, 227, 222, 0.1)',
      fg: '#e4e3de',
      fgMuted: '#acaa9d',
      fgFaint: '#7b796d',
      border: '#312f27',
      borderStrong: '#434139',
      accent: '#bcb554',
      accentFg: '#191700',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#2c2b18',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'ember',
    name: 'Ember',
    group: 'warm',
    description: 'Charcoal with a glowing ember-orange accent.',
    light: {
      bg: '#fff6f1',
      bgElev: '#fefdfd',
      bgSunken: '#faede7',
      bgHover: 'rgba(44, 32, 25, 0.05)',
      bgActive: 'rgba(44, 32, 25, 0.085)',
      fg: '#2c2019',
      fgMuted: '#775d4f',
      fgFaint: '#9d8578',
      border: '#eadcd5',
      borderStrong: '#d7c9c1',
      accent: '#ab5902',
      accentFg: '#fefbf9',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#fce9db',
      shadow: '0 8px 30px rgba(45, 30, 21, 0.14)'
    },
    dark: {
      bg: '#1e1815',
      bgElev: '#27211d',
      bgSunken: '#18120f',
      bgHover: 'rgba(230, 226, 223, 0.06)',
      bgActive: 'rgba(230, 226, 223, 0.1)',
      fg: '#e6e2df',
      fgMuted: '#b3a6a0',
      fgFaint: '#827670',
      border: '#352d29',
      borderStrong: '#473f3b',
      accent: '#f89547',
      accentFg: '#260f00',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#36261a',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'cappuccino',
    name: 'Cappuccino',
    group: 'warm',
    description: 'Coffee-house browns with a caramel accent.',
    light: {
      bg: '#fdf1e8',
      bgElev: '#fffbf7',
      bgSunken: '#f7e9df',
      bgHover: 'rgba(44, 32, 23, 0.05)',
      bgActive: 'rgba(44, 32, 23, 0.085)',
      fg: '#2c2017',
      fgMuted: '#755e4c',
      fgFaint: '#9b8676',
      border: '#e8d9cd',
      borderStrong: '#d5c5b8',
      accent: '#73502b',
      accentFg: '#fffbf8',
      green: '#0a7e3a',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#fce9d7',
      shadow: '0 8px 30px rgba(46, 29, 15, 0.14)'
    },
    dark: {
      bg: '#201811',
      bgElev: '#292019',
      bgSunken: '#19110b',
      bgHover: 'rgba(232, 226, 221, 0.06)',
      bgActive: 'rgba(232, 226, 221, 0.1)',
      fg: '#e8e2dd',
      fgMuted: '#b4a69c',
      fgFaint: '#83766c',
      border: '#362d26',
      borderStrong: '#493f37',
      accent: '#cea985',
      accentFg: '#1e1409',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#352719',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'solarium',
    name: 'Solarium',
    group: 'warm',
    description: 'Sun-warmed sand with a deep teal ink accent.',
    light: {
      bg: '#fff7e8',
      bgElev: '#fffdfa',
      bgSunken: '#f9efda',
      bgHover: 'rgba(40, 34, 21, 0.05)',
      bgActive: 'rgba(40, 34, 21, 0.085)',
      fg: '#282215',
      fgMuted: '#6e6249',
      fgFaint: '#948973',
      border: '#eadec7',
      borderStrong: '#d7cbb2',
      accent: '#017b7f',
      accentFg: '#f7fdfd',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#cff6f6',
      shadow: '0 8px 30px rgba(45, 31, 0, 0.14)'
    },
    dark: {
      bg: '#1d1911',
      bgElev: '#262219',
      bgSunken: '#17130b',
      bgHover: 'rgba(229, 227, 221, 0.06)',
      bgActive: 'rgba(229, 227, 221, 0.1)',
      fg: '#e5e3dd',
      fgMuted: '#afa99b',
      fgFaint: '#7e786b',
      border: '#332f26',
      borderStrong: '#454137',
      accent: '#64c3c6',
      accentFg: '#001b1c',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#152f30',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'claret',
    name: 'Claret',
    group: 'warm',
    description: 'Wine-cellar reds with a soft rose accent.',
    light: {
      bg: '#fef5f6',
      bgElev: '#fefdfd',
      bgSunken: '#fbecee',
      bgHover: 'rgba(45, 30, 32, 0.05)',
      bgActive: 'rgba(45, 30, 32, 0.085)',
      fg: '#2d1e20',
      fgMuted: '#785a5e',
      fgFaint: '#9f8286',
      border: '#ebdbdd',
      borderStrong: '#d8c7c9',
      accent: '#a02d47',
      accentFg: '#fefbfb',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#fee6e8',
      shadow: '0 8px 30px rgba(46, 28, 30, 0.14)'
    },
    dark: {
      bg: '#241517',
      bgElev: '#2d1d1f',
      bgSunken: '#1d0f11',
      bgHover: 'rgba(235, 224, 225, 0.06)',
      bgActive: 'rgba(235, 224, 225, 0.1)',
      fg: '#ebe0e1',
      fgMuted: '#baa2a5',
      fgFaint: '#897275',
      border: '#3b2a2c',
      borderStrong: '#4e3b3e',
      accent: '#ee939e',
      accentFg: '#260c11',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#3a2225',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'ultraviolet',
    name: 'Ultraviolet',
    group: 'vivid',
    description: 'Deep violet with a lavender accent.',
    light: {
      bg: '#f8f7fe',
      bgElev: '#fdfdfe',
      bgSunken: '#f1eefc',
      bgHover: 'rgba(36, 32, 46, 0.05)',
      bgActive: 'rgba(36, 32, 46, 0.085)',
      fg: '#24202e',
      fgMuted: '#655f78',
      fgFaint: '#8c879e',
      border: '#e0ddec',
      borderStrong: '#cdcada',
      accent: '#7a4fbf',
      accentFg: '#fcfbfe',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#efe9ff',
      shadow: '0 8px 30px rgba(35, 31, 47, 0.14)'
    },
    dark: {
      bg: '#1b1628',
      bgElev: '#231f31',
      bgSunken: '#151021',
      bgHover: 'rgba(227, 225, 234, 0.06)',
      bgActive: 'rgba(227, 225, 234, 0.1)',
      fg: '#e3e1ea',
      fgMuted: '#aaa5be',
      fgFaint: '#7a758c',
      border: '#302b40',
      borderStrong: '#423d53',
      accent: '#bb9ef9',
      accentFg: '#191029',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#2d253e',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'blossom',
    name: 'Blossom',
    group: 'vivid',
    description: 'Muted petal tones with a peony-pink accent.',
    light: {
      bg: '#fef5fa',
      bgElev: '#fffdfe',
      bgSunken: '#f9ecf3',
      bgHover: 'rgba(43, 31, 37, 0.05)',
      bgActive: 'rgba(43, 31, 37, 0.085)',
      fg: '#2b1f25',
      fgMuted: '#745a68',
      fgFaint: '#9b838f',
      border: '#e9dbe2',
      borderStrong: '#d6c7cf',
      accent: '#af467e',
      accentFg: '#fefbfc',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#fde6ef',
      shadow: '0 8px 30px rgba(43, 28, 37, 0.14)'
    },
    dark: {
      bg: '#1f171b',
      bgElev: '#281f24',
      bgSunken: '#191115',
      bgHover: 'rgba(231, 225, 228, 0.06)',
      bgActive: 'rgba(231, 225, 228, 0.1)',
      fg: '#e7e1e4',
      fgMuted: '#b3a4ac',
      fgFaint: '#82747c',
      border: '#362c31',
      borderStrong: '#483e43',
      accent: '#ea91bc',
      accentFg: '#250c19',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#36242c',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'dusk',
    name: 'Dusk',
    group: 'vivid',
    description: 'Twilight plum-gray with an orchid accent.',
    light: {
      bg: '#faf6fe',
      bgElev: '#fefdff',
      bgSunken: '#f3eef7',
      bgHover: 'rgba(38, 32, 42, 0.05)',
      bgActive: 'rgba(38, 32, 42, 0.085)',
      fg: '#26202a',
      fgMuted: '#6a5e73',
      fgFaint: '#91859a',
      border: '#e3dde8',
      borderStrong: '#cfc9d5',
      accent: '#94489c',
      accentFg: '#fefafe',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#f2e8fa',
      shadow: '0 8px 30px rgba(37, 30, 42, 0.14)'
    },
    dark: {
      bg: '#1d1721',
      bgElev: '#251f2a',
      bgSunken: '#16111b',
      bgHover: 'rgba(229, 225, 232, 0.06)',
      bgActive: 'rgba(229, 225, 232, 0.1)',
      fg: '#e5e1e8',
      fgMuted: '#aea5b6',
      fgFaint: '#7d7585',
      border: '#332c38',
      borderStrong: '#453e4a',
      accent: '#d796dc',
      accentFg: '#200e22',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#2f2537',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  },
  {
    id: 'nebula',
    name: 'Nebula',
    group: 'vivid',
    description: 'Indigo space with a cyan glow — subtly animated.',
    animated: true,
    light: {
      bg: '#f6f7ff',
      bgElev: '#fdfdfe',
      bgSunken: '#ecefff',
      bgHover: 'rgba(31, 34, 47, 0.05)',
      bgActive: 'rgba(31, 34, 47, 0.085)',
      fg: '#1f222f',
      fgMuted: '#5c627a',
      fgFaint: '#8489a0',
      border: '#dadff1',
      borderStrong: '#c6cbdf',
      accent: '#066d8e',
      accentFg: '#f8fdff',
      green: '#11813c',
      amber: '#8e6200',
      red: '#ae4440',
      blue: '#2a6cba',
      purple: '#814fb2',
      cyan: '#037a84',
      userBubble: '#e7ecff',
      shadow: '0 8px 30px rgba(28, 32, 53, 0.14)'
    },
    dark: {
      bg: '#14172e',
      bgElev: '#1c2038',
      bgSunken: '#0e1127',
      bgHover: 'rgba(224, 226, 235, 0.06)',
      bgActive: 'rgba(224, 226, 235, 0.1)',
      fg: '#e0e2eb',
      fgMuted: '#a2a8c0',
      fgFaint: '#72788e',
      border: '#282d47',
      borderStrong: '#3a3f5a',
      accent: '#44d4e2',
      accentFg: '#001b1e',
      green: '#77cc8b',
      amber: '#e3aa48',
      red: '#fc958d',
      blue: '#83b9fe',
      purple: '#ca9efc',
      cyan: '#2bccdc',
      userBubble: '#222746',
      shadow: '0 10px 40px rgba(0, 0, 0, 0.5)'
    }
  }
];

export const PALETTE_IDS: PaletteId[] = PALETTES.map((p) => p.id);

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  neutral: 'Neutral',
  cool: 'Cool',
  nature: 'Nature',
  warm: 'Warm',
  vivid: 'Vivid'
};

/** Picker order: groups in this order, palettes in catalogue order within each group. */
export const GROUP_ORDER: PaletteGroup[] = ['neutral', 'cool', 'nature', 'warm', 'vivid'];

/**
 * Theme ids written by builds that had one flat list of 23 single-variant themes. Each maps onto
 * the family it became and the mode it used to paint, so an upgrade keeps the look a user chose.
 */
export const LEGACY_THEMES: Readonly<Record<string, { theme: ThemeMode; palette: PaletteId }>> = {
  midnight: { theme: 'dark', palette: 'midnight' },
  abyss: { theme: 'dark', palette: 'abyss' },
  blueprint: { theme: 'light', palette: 'midnight' },
  admiral: { theme: 'dark', palette: 'admiral' },
  nebula: { theme: 'dark', palette: 'nebula' },
  ultraviolet: { theme: 'dark', palette: 'ultraviolet' },
  magma: { theme: 'dark', palette: 'ember' },
  solarium: { theme: 'light', palette: 'solarium' },
  blossom: { theme: 'light', palette: 'blossom' },
  citrine: { theme: 'light', palette: 'citrine' },
  cappuccino: { theme: 'light', palette: 'cappuccino' },
  meadow: { theme: 'light', palette: 'meadow' },
  porcelain: { theme: 'light', palette: 'slate' },
  lavender: { theme: 'light', palette: 'ultraviolet' },
  evergreen: { theme: 'dark', palette: 'evergreen' },
  graphite: { theme: 'dark', palette: 'graphite' },
  ember: { theme: 'dark', palette: 'ember' },
  lagoon: { theme: 'dark', palette: 'lagoon' },
  fjord: { theme: 'dark', palette: 'fjord' },
  claret: { theme: 'dark', palette: 'claret' }
};

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && PALETTE_IDS.includes(v as PaletteId);
}

export function findPalette(id: string): PaletteDescriptor | undefined {
  return PALETTES.find((p) => p.id === id);
}

/**
 * Reads a stored mode and palette, upgrading a legacy single-variant theme id. Anything unknown
 * (removed from the catalogue, or hand-edited into settings.json) falls back to System + Default.
 */
export function migrateTheme(theme: unknown, palette: unknown): { theme: ThemeMode; palette: PaletteId } {
  if (isThemeMode(theme)) return { theme, palette: isPaletteId(palette) ? palette : DEFAULT_PALETTE };
  const legacy = typeof theme === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_THEMES, theme) ? LEGACY_THEMES[theme] : undefined;
  if (legacy) return { ...legacy };
  return { theme: DEFAULT_THEME_MODE, palette: isPaletteId(palette) ? palette : DEFAULT_PALETTE };
}

/** Resolves a mode to the scheme it paints; `system` has no answer of its own, so callers pass the OS's. */
export function resolveScheme(mode: string, systemDark: boolean): ColorScheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemDark ? 'dark' : 'light';
}

/** The `nativeTheme.themeSource` a mode needs so OS-drawn surfaces match it. */
export function themeSourceFor(mode: string): ThemeMode {
  return isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
}

/** A palette's variant for a scheme; an unknown palette id paints as Default. */
export function variantFor(palette: string, scheme: ColorScheme): ThemePalette {
  return (findPalette(palette) ?? PALETTES[0])[scheme];
}

export function chromeFor(palette: string, scheme: ColorScheme): ThemeChrome {
  const v = variantFor(palette, scheme);
  return { color: v.bgElev, symbolColor: v.fg };
}

/** Three representative colors for a palette swatch, in paint order (base, raised, accent). */
export function swatchFor(palette: string, scheme: ColorScheme): [string, string, string] {
  const v = variantFor(palette, scheme);
  return [v.bgSunken, v.bgElev, v.accent];
}

function cssName(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Categorical series colours for the analytics charts (`--chart-1` … `--chart-6`), one set per
 * scheme rather than per palette: the palette hues are UI accents, and a data palette has
 * colour-vision and lightness checks to pass that UI accents do not. This order clears every
 * adjacent-pair check on all catalogue surfaces; the first three slots also pass all-pairs. Light
 * surfaces put slots 3–5 below 3:1 contrast, so every chart ships a legend, hover values and a
 * table view.
 */
export const CHART_SERIES: Record<ColorScheme, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
};

export function chartSeriesCss(scheme: ColorScheme): string[] {
  return CHART_SERIES[scheme].map((hex, i) => `  --chart-${i + 1}: ${hex};`);
}

/**
 * CSS for every palette variant, keyed on the `data-palette` and resolved `data-scheme`
 * attributes that `src/renderer/src/theme.ts` keeps on `<html>`.
 *
 * The selectors are prefixed with `html` so they outrank the pre-script fallback in `styles.css`
 * regardless of which stylesheet the browser sees first.
 */
export function themeCss(): string {
  const blocks: string[] = [];
  for (const p of PALETTES) {
    for (const scheme of ['light', 'dark'] as const) {
      const decls = Object.entries(p[scheme]).map(([k, v]) => `  ${cssName(k)}: ${v};`);
      decls.unshift(`  color-scheme: ${scheme};`);
      decls.push(...chartSeriesCss(scheme));
      blocks.push(`html:root[data-palette='${p.id}'][data-scheme='${scheme}'] {\n${decls.join('\n')}\n}`);
    }
  }
  return blocks.join('\n');
}
