export const COR_PADRAO = '#0b5cab';

function parse(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(rgb: [number, number, number], target: number, amount: number): string {
  const [r, g, b] = rgb.map((c) => Math.round(c + (target - c) * amount));
  return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Define --cor-primaria e derivadas (hover, suave, texto sobre a cor) a partir de #RRGGBB. */
export function applyBranding(color?: string | null): void {
  const rgb = parse(color ?? '') ?? (parse(COR_PADRAO) as [number, number, number]);
  const style = document.documentElement.style;
  const base = `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  style.setProperty('--cor-primaria', base);
  style.setProperty('--cor-primaria-hover', mix(rgb, 0, 0.18));
  style.setProperty('--cor-primaria-suave', mix(rgb, 255, 0.9));
  style.setProperty('--cor-primaria-borda', mix(rgb, 255, 0.6));
  // Texto sobre a cor principal: branco, salvo cores muito claras.
  style.setProperty('--cor-sobre-primaria', luminance(rgb) > 0.5 ? '#111827' : '#ffffff');
}
