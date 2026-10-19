import { ImageResponse } from 'next/og';

import { businessConfig } from '@/config/business';

/**
 * Imagen Open Graph generada en build con `next/og` (viene con Next, 0 deps).
 * Se usa para compartir el sitio en redes/WhatsApp sin subir un asset binario.
 */
export const alt = `${businessConfig.name} — alimentos y tecnología seleccionados`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0a0a0a',
          color: '#ededed',
          padding: '72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 34, letterSpacing: -1, opacity: 0.85 }}>
          {businessConfig.name.toLowerCase()}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', fontSize: 76, fontWeight: 600, letterSpacing: -3, lineHeight: 1.05 }}>
            Considered. Curated. Exceptional.
          </div>
          <div style={{ display: 'flex', fontSize: 30, color: '#b8b8c0' }}>
            Alimentos y tecnología · Retiro en tienda · Lima, Perú
          </div>
        </div>
        <div style={{ display: 'flex', width: '100%', height: 6, background: '#ffffff', opacity: 0.9 }} />
      </div>
    ),
    { ...size },
  );
}
