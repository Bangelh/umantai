'use client';

import { useEffect, useState } from 'react';
import { envConfig } from '@/lib/env';

interface ServerStatus {
  database: { configured: boolean; resolvedFrom?: string; isNonPooling?: boolean; urlMasked?: string };
  supabase: { urlConfigured: boolean; urlMasked?: string; serviceRoleConfigured?: boolean };
  whatsapp: { salesConfigured: boolean; supportConfigured: boolean };
  vercel: { env: string; url: string; isProduction?: boolean; isPreview?: boolean };
}

export function EnvironmentStatus() {
  const clientEnv = envConfig; // only has NEXT_PUBLIC_ + build-time safe values
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    // Fetch real server-side status (masked, safe for admin)
    fetch('/api/debug/env', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setServerStatus({
            database: data.database || { configured: false },
            supabase: data.supabase || { urlConfigured: false },
            whatsapp: data.whatsapp || { salesConfigured: false, supportConfigured: false },
            vercel: data.vercel || clientEnv.vercel,
          });
        }
      })
      .catch(() => {
        // fallback to client view if fetch fails
      });
  }, []);

  const useServer = !!serverStatus;

  const supabaseConfigured = useServer ? serverStatus!.supabase.urlConfigured : !!clientEnv.supabase.url;
  const dbConfigured = useServer ? serverStatus!.database.configured : !!clientEnv.database.url;
  const isPooled = useServer ? serverStatus!.database.isPooled : /pooler|pooler\.supabase/i.test(clientEnv.database.url || '');
  const dbStatus = useServer
    ? (serverStatus!.database.isNonPooling && !serverStatus!.database.isPooled ? 'Non-pooling (preferred)' : 'Pooled / misconfigured')
    : (clientEnv.database.nonPoolingUrl && !isPooled ? 'Non-pooling (preferred)' : 'Pooled / misconfigured');
  const whatsappConfigured = useServer ? serverStatus!.whatsapp.salesConfigured : !!clientEnv.whatsapp.salesPhone;
  const vercelEnv = useServer ? serverStatus!.vercel : clientEnv.vercel;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="border border-white/10 bg-neutral-900 rounded-2xl p-4">
        <div className="text-xs text-white/50 mb-1">SUPABASE</div>
        <div className={`text-sm font-medium ${supabaseConfigured ? 'text-emerald-400' : 'text-red-400'}`}>
          {supabaseConfigured ? 'Connected' : 'Not configured'}
        </div>
        {supabaseConfigured && (
          <div className="text-[10px] text-white/40 mt-1 truncate">
            {useServer ? serverStatus!.supabase.urlMasked : clientEnv.supabase.url?.replace('https://', '')}
          </div>
        )}
      </div>

      <div className="border border-white/10 bg-neutral-900 rounded-2xl p-4">
        <div className="text-xs text-white/50 mb-1">DATABASE (Postgres)</div>
        <div className={`text-sm font-medium ${dbConfigured ? 'text-emerald-400' : 'text-red-400'}`}>
          {dbConfigured ? 'Connected' : 'Not configured'}
        </div>
        {dbConfigured && (
          <div className="text-[10px] text-white/40 mt-1">
            {dbStatus}
            {useServer && serverStatus!.database.resolvedFrom && ` (from ${serverStatus!.database.resolvedFrom})`}
            {isPooled && <span className="text-red-400 ml-1">⚠️ contains pooler</span>}
          </div>
        )}
        {!dbConfigured && (
          <div className="text-[10px] text-white/40 mt-1">Run <code>vercel env pull</code> locally or set <code>POSTGRES_URL_NON_POOLING</code> (and <code>UMANTAI_URL_POSTGRES_URL_NON_POOLING</code>) in Vercel dashboard for the primary project.</div>
        )}
        {dbConfigured && isPooled && (
          <div className="text-[9px] text-red-400 mt-1">Use the DIRECT (non-pooled) connection string from Supabase → "Direct connection".</div>
        )}
      </div>

      <div className="border border-white/10 bg-neutral-900 rounded-2xl p-4">
        <div className="text-xs text-white/50 mb-1">WHATSAPP</div>
        <div className={`text-sm font-medium ${whatsappConfigured ? 'text-emerald-400' : 'text-red-400'}`}>
          {whatsappConfigured ? 'Configured' : 'Not configured'}
        </div>
        {whatsappConfigured && (
          <div className="text-[10px] text-white/40 mt-1">Sales: {clientEnv.whatsapp.salesPhone}</div>
        )}
      </div>

      <div className="border border-white/10 bg-neutral-900 rounded-2xl p-4">
        <div className="text-xs text-white/50 mb-1">ENVIRONMENT</div>
        <div className="text-sm font-medium flex items-center gap-2">
          {vercelEnv.env?.toUpperCase?.() || 'PRODUCTION'}
          {(useServer ? serverStatus!.vercel.isProduction : vercelEnv.isProduction) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">PROD</span>}
          {(useServer ? serverStatus!.vercel.isPreview : vercelEnv.isPreview) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">PREVIEW</span>}
        </div>
        <div className="text-[10px] text-white/40 mt-1 truncate">{useServer ? serverStatus!.vercel.url : vercelEnv.url}</div>
        {useServer && <div className="text-[9px] text-white/30 mt-1">Real server status (masked)</div>}
      </div>
    </div>
  );
}
