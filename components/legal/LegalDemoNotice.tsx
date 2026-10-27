import { LEGAL_DEMO_NOTICE, LEGAL_DEMO_NOTICE_BODY } from '@/config/legal-demo';

/**
 * components/legal/LegalDemoNotice.tsx — aviso visible de datos DEMO.
 *
 * Se renderiza SIEMPRE que una página muestre datos legales de demostración
 * (`isLegalDemoDataActive()`), para que nadie confunda el ejemplo de staging con
 * los datos reales del titular. Sin dependencias de servidor: sirve igual en
 * páginas y en componentes cliente.
 *
 * El texto no está acá: vive en `config/legal-demo.ts`, junto a los valores demo,
 * para que el aviso exigido tenga una sola fuente literal.
 */
export function LegalDemoNotice({ className = 'mt-6' }: { className?: string }) {
  return (
    <div
      role="note"
      className={`${className} rounded-2xl border-2 border-warning/60 bg-warning/15 p-4 text-sm text-warning`}
    >
      <p className="font-semibold uppercase tracking-wide">{LEGAL_DEMO_NOTICE}</p>
      <p className="mt-1">{LEGAL_DEMO_NOTICE_BODY}</p>
    </div>
  );
}
