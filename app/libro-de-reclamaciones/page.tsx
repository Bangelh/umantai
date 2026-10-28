import type { Metadata } from 'next';

import {
  businessConfig,
  businessValue,
  isLegalDemoDataActive,
  isLegalReadyForLaunch,
  legalContactEmail,
  pendingBusinessFields,
  whatsappDisplay,
} from '@/config/business';
import { getTranslator } from '@/lib/i18n/server';
import { ComplaintPage } from './ComplaintPage';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  // El título lleva sólo el nombre de la página: el layout raíz agrega la marca.
  const title = t('complaints.metaTitle');
  const description = t('complaints.metaDescription');
  const canonical = `${businessConfig.siteUrl}/libro-de-reclamaciones`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'website',
      title: `${title} | ${businessConfig.name}`,
      description,
      url: canonical,
      siteName: businessConfig.name,
    },
  };
}

export default async function ComplaintsBookPage() {
  const { t } = await getTranslator();

  return (
    <ComplaintPage
      provider={{
        name: businessConfig.name,
        legalName: businessValue('legalName'),
        ruc: businessValue('ruc'),
        address: businessValue('address'),
        jurisdiction: businessValue('jurisdiction'),
        contact: legalContactEmail(),
        whatsapp: whatsappDisplay(),
      }}
      legalReady={isLegalReadyForLaunch()}
      demoData={isLegalDemoDataActive()}
      pendingFields={pendingBusinessFields()}
      pendingFieldNames={pendingBusinessFields().map((field) => t(`complaints.field.${field}`))}
    />
  );
}
