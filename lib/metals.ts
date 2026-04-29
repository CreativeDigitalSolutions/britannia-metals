export type Metal =
  | 'copper'
  | 'aluminium'
  | 'zinc'
  | 'nickel'
  | 'lead'
  | 'tin'
  | 'gold'
  | 'silver';

export type MetalCategory = 'base' | 'precious';

export interface MetalConfig {
  id: Metal;
  display_name: string;       // 'Copper'
  symbol: string;              // 'Cu' — the chemical symbol, used as a compact label
  category: MetalCategory;
  lme_code: string | null;     // LME trading symbol, e.g. 'CA' (copper), 'AH' (aluminium). Null for gold/silver.
  yahoo_symbol: string | null; // Yahoo Finance ticker, e.g. 'HG=F'. Null when we have no Yahoo coverage.
  unit: 'tonne' | 'troy_oz';
  accent_color: string;        // hex — used for chart series colours; keep editorial, not neon
}

export const METALS: MetalConfig[] = [
  {
    id: 'copper',
    display_name: 'Copper',
    symbol: 'Cu',
    category: 'base',
    lme_code: 'CA',
    yahoo_symbol: 'HG=F',
    unit: 'tonne',
    accent_color: '#B87333',  // copper
  },
  {
    id: 'aluminium',
    display_name: 'Aluminium',
    symbol: 'Al',
    category: 'base',
    lme_code: 'AH',
    yahoo_symbol: 'ALI=F',
    unit: 'tonne',
    accent_color: '#A8A9AD',  // silver-grey
  },
  {
    id: 'zinc',
    display_name: 'Zinc',
    symbol: 'Zn',
    category: 'base',
    lme_code: 'ZS',
    yahoo_symbol: null,
    unit: 'tonne',
    accent_color: '#7B8B99',  // slate blue-grey
  },
  {
    id: 'nickel',
    display_name: 'Nickel',
    symbol: 'Ni',
    category: 'base',
    lme_code: 'NI',
    yahoo_symbol: null,
    unit: 'tonne',
    accent_color: '#5E6C75',  // dark slate
  },
  {
    id: 'lead',
    display_name: 'Lead',
    symbol: 'Pb',
    category: 'base',
    lme_code: 'PB',
    yahoo_symbol: null,
    unit: 'tonne',
    accent_color: '#4A5058',  // gunmetal
  },
  {
    id: 'tin',
    display_name: 'Tin',
    symbol: 'Sn',
    category: 'base',
    lme_code: 'SN',
    yahoo_symbol: null,
    unit: 'tonne',
    accent_color: '#8D9BA3',  // muted tin
  },
  {
    id: 'gold',
    display_name: 'Gold',
    symbol: 'Au',
    category: 'precious',
    lme_code: null,
    yahoo_symbol: 'GC=F',
    unit: 'troy_oz',
    accent_color: '#B8860B',  // dark goldenrod — editorial, not bling
  },
  {
    id: 'silver',
    display_name: 'Silver',
    symbol: 'Ag',
    category: 'precious',
    lme_code: null,
    yahoo_symbol: 'SI=F',
    unit: 'troy_oz',
    accent_color: '#8B8680',  // warm silver-grey
  },
];

// Helper — used throughout the app
export function getMetal(id: Metal): MetalConfig {
  const m = METALS.find(m => m.id === id);
  if (!m) throw new Error(`Unknown metal: ${id}`);
  return m;
}

export const BASE_METALS = METALS.filter(m => m.category === 'base');
export const PRECIOUS_METALS = METALS.filter(m => m.category === 'precious');
