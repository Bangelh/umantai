"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { EnvironmentStatus } from "@/app/admin/components/EnvironmentStatus";
import type { EnvDebugInfo } from "@/lib/env";

export default function DebugEnvPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [debugInfo, setDebugInfo] = useState<EnvDebugInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === "umantai" || password === "admin") {
      setIsAuthenticated(true);
    } else {
      alert("Wrong password. Try 'umantai'");
    }
  };

  async function loadDebugInfo() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/debug/env', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: EnvDebugInfo = await res.json();
      setDebugInfo(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load diagnostics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isAuthenticated) {
      loadDebugInfo();
    }
  }, [isAuthenticated]);

  async function copyReport() {
    if (!debugInfo) return;
    const text = JSON.stringify(debugInfo, null, 2);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <div className="max-w-md w-full px-8">
          <div className="text-center mb-8">
            <div className="text-4xl font-semibold tracking-tighter mb-2">umantai</div>
            <div className="text-white/60">Debug • Environment</div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin password"
              className="w-full bg-neutral-900 border border-white/20 rounded-xl px-4 py-3 text-lg focus:outline-none focus:border-white/40"
              autoFocus
            />
            <button
              type="submit"
              className="w-full py-3 bg-white text-black rounded-xl font-medium hover:bg-white/90 transition-colors"
            >
              View Environment Status
            </button>
          </form>

          <p className="text-center text-white/40 text-sm mt-6">
            Password: <span className="font-mono">umantai</span>
          </p>

          <div className="mt-8 text-center">
            <Link href="/" className="text-sm text-white/50 hover:text-white">← Back to site</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="border-b border-white/10 bg-neutral-950/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-semibold text-2xl tracking-[-1px]">umantai</Link>
            <div className="text-sm px-3 py-1 rounded-full bg-white/10 text-white/80">Debug • Environment</div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={loadDebugInfo}
              disabled={loading}
              className="text-sm px-3 py-1 rounded-lg border border-white/20 hover:bg-white/5 disabled:opacity-50"
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <Link href="/" className="text-sm text-white/70 hover:text-white">← Back to site</Link>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-10">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-4xl tracking-tighter font-semibold">Environment Status</h1>
            <p className="text-white/60 mt-1">Live view of Supabase, Database, WhatsApp, and deployment environment.</p>
          </div>
          {debugInfo && (
            <button
              onClick={copyReport}
              className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/15 hover:bg-white/10 active:bg-white/20 transition"
            >
              {copied ? 'Copied!' : 'Copy full JSON report'}
            </button>
          )}
        </div>

        {/* Quick glance cards (works with client-visible values) */}
        <EnvironmentStatus />

        {/* Advanced Server Diagnostics */}
        <div className="mt-10">
          <div className="flex items-center justify-between mb-3 px-1">
            <div>
              <div className="text-xs uppercase tracking-[1px] text-white/50">Advanced Server Diagnostics</div>
              <div className="text-lg font-medium">Full resolved configuration (server-side)</div>
            </div>
            {debugInfo && (
              <div className="text-[10px] text-white/40 font-mono">
                Snapshot: {new Date(debugInfo.timestamp).toLocaleString()}
              </div>
            )}
          </div>

          {loading && !debugInfo && (
            <div className="border border-white/10 bg-neutral-900 rounded-3xl p-12 text-center text-white/60">
              Loading server diagnostics…
            </div>
          )}

          {error && (
            <div className="border border-red-500/30 bg-red-950/30 rounded-3xl p-6 text-red-300">
              Failed to load advanced diagnostics: {error}. The basic status cards above may still be useful.
            </div>
          )}

          {debugInfo && (
            <div className="space-y-6">
              {/* Runtime */}
              <div className="border border-white/10 bg-neutral-900 rounded-3xl p-6">
                <div className="text-xs text-white/50 mb-3">RUNTIME</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-white/50 text-xs">Node</div>
                    <div className="font-medium">{debugInfo.runtime.nodeVersion}</div>
                  </div>
                  <div>
                    <div className="text-white/50 text-xs">Platform</div>
                    <div className="font-medium">{debugInfo.runtime.platform}</div>
                  </div>
                  <div>
                    <div className="text-white/50 text-xs">Vercel Runtime</div>
                    <div className={`font-medium ${debugInfo.runtime.vercel ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {debugInfo.runtime.vercel ? 'Yes (VERCEL=1)' : 'No (local / other)'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Vercel Environment — the key one user asked for */}
              <div className="border border-white/10 bg-neutral-900 rounded-3xl p-6">
                <div className="text-xs text-white/50 mb-3">VERCEL ENVIRONMENT &amp; DEPLOYMENT</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                  <KV label="VERCEL_ENV" value={debugInfo.vercel.env} highlight />
                  <KV label="VERCEL_URL" value={debugInfo.vercel.url} />
                  <KV label="VERCEL_REGION" value={debugInfo.vercel.VERCEL_REGION || '—'} />
                  <KV label="VERCEL" value={debugInfo.vercel.VERCEL || '—'} />

                  <div className="md:col-span-2 border-t border-white/10 my-1" />

                  <KV label="GIT COMMIT SHA" value={debugInfo.vercel.VERCEL_GIT_COMMIT_SHA || '—'} mono />
                  <KV label="GIT REF" value={debugInfo.vercel.VERCEL_GIT_COMMIT_REF || '—'} />
                  <KV label="GIT REPO" value={[debugInfo.vercel.VERCEL_GIT_REPO_OWNER, debugInfo.vercel.VERCEL_GIT_REPO_SLUG].filter(Boolean).join('/') || '—'} />
                  <KV label="GIT MESSAGE" value={debugInfo.vercel.VERCEL_GIT_COMMIT_MESSAGE || '—'} />
                </div>
                <div className="mt-4 text-[11px] text-white/40">
                  Current environment: <span className="font-medium text-white/70">{debugInfo.vercel.env.toUpperCase()}</span>
                  {debugInfo.vercel.isProduction && ' — production deployment'}
                  {debugInfo.vercel.isPreview && ' — preview deployment'}
                  {debugInfo.vercel.isDevelopment && ' — local development'}
                </div>
              </div>

              {/* Database Resolution Status — heavily featured per user request */}
              <div className="border border-white/10 bg-neutral-900 rounded-3xl p-6">
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-xs text-white/50">DATABASE (VERCEL POSTGRES)</div>
                  <div className={`text-[10px] px-2 py-0.5 rounded ${debugInfo.database.configured ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                    {debugInfo.database.configured ? 'CONFIGURED' : 'MISSING'}
                  </div>
                  {debugInfo.database.isPooled && (
                    <div className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-400">POOLER</div>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="text-xs text-white/50">Resolved from (priority order)</div>
                    <div className="font-semibold text-lg tracking-tight">
                      {debugInfo.database.resolvedFrom}
                    </div>
                    {debugInfo.database.effectiveIsNonPooling && (
                      <div className="text-emerald-400 text-xs mt-0.5">✓ Using NON-POOLING (direct) connection (recommended for serverless)</div>
                    )}
                    {debugInfo.database.isNonPooling && debugInfo.database.isPooled && (
                      <div className="text-amber-400 text-xs mt-0.5">Resolved from NON_POOLING var name, but value contains pooler — not actually direct</div>
                    )}
                    {!debugInfo.database.isNonPooling && debugInfo.database.configured && !debugInfo.database.isPooled && (
                      <div className="text-amber-400 text-xs mt-0.5">Using pooled connection — set POSTGRES_URL_NON_POOLING (direct) for better reliability</div>
                    )}
                    {debugInfo.database.isPooled && (
                      <div className="mt-0.5">
                        <span className="inline-flex items-center gap-1 text-amber-500 text-xs font-medium">
                          <span>⚠️</span>
                          <span>Connection pooler detected — use the Direct (non-pooled) connection string from Supabase.</span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-xs text-white/50 mb-1">Masked connection string</div>
                    <div className="font-mono text-xs bg-black/40 border border-white/10 rounded-xl px-4 py-3 break-all text-white/70">
                      {debugInfo.database.urlMasked}
                    </div>
                    <div className="text-[10px] text-white/40 mt-1">Length: {debugInfo.database.urlLength} chars {debugInfo.database.urlLength > 40 ? '✓ looks valid' : '(may be incomplete)'}</div>
                  </div>

                  {!debugInfo.database.configured && (
                    <div className="text-xs bg-neutral-950 border border-white/10 rounded-xl p-3 text-white/60">
                      Fix: Run <span className="font-mono">vercel env pull .env.local</span> locally, or connect Postgres in the dashboard (Vercel Marketplace/Neon/Supabase) and pull the vars.
                    </div>
                  )}
                </div>
              </div>

              {/* Supabase */}
              <div className="border border-white/10 bg-neutral-900 rounded-3xl p-6">
                <div className="text-xs text-white/50 mb-3">SUPABASE</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
                  <div>
                    <div className="text-white/50 text-xs">URL</div>
                    <div className={`font-medium ${debugInfo.supabase.urlConfigured ? 'text-emerald-400' : 'text-red-400'}`}>
                      {debugInfo.supabase.urlConfigured ? 'Configured' : 'Missing'}
                    </div>
                    {debugInfo.supabase.urlMasked && (
                      <div className="font-mono text-[11px] text-white/50 mt-1">{debugInfo.supabase.urlMasked}</div>
                    )}
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between border-b border-white/10 pb-1">
                      <span className="text-white/60">Anon Key</span>
                      <span className={debugInfo.supabase.anonKeyConfigured ? 'text-emerald-400' : 'text-red-400'}>
                        {debugInfo.supabase.anonKeyConfigured ? 'Present (' + debugInfo.supabase.anonKeyMasked + ')' : 'Missing'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-white/10 pb-1">
                      <span className="text-white/60">Service Role Key</span>
                      <span className={debugInfo.supabase.serviceRoleConfigured ? 'text-emerald-400' : 'text-red-400'}>
                        {debugInfo.supabase.serviceRoleConfigured ? 'Present (' + debugInfo.supabase.serviceRoleMasked + ')' : 'Missing (required for notes + admin)'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* WhatsApp + Presence Summary */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="border border-white/10 bg-neutral-900 rounded-3xl p-6">
                  <div className="text-xs text-white/50 mb-3">WHATSAPP</div>
                  <div className="space-y-1 text-sm">
                    <div className={debugInfo.whatsapp.salesConfigured ? 'text-emerald-400' : 'text-red-400'}>
                      Sales phone: {debugInfo.whatsapp.salesConfigured ? 'Configured' : 'Missing'}
                    </div>
                    <div className={debugInfo.whatsapp.supportConfigured ? 'text-emerald-400' : 'text-red-400'}>
                      Support phone: {debugInfo.whatsapp.supportConfigured ? 'Configured' : 'Missing'}
                    </div>
                  </div>
                </div>

                <div className="border border-white/10 bg-neutral-900 rounded-3xl p-6">
                  <div className="text-xs text-white/50 mb-3">CRITICAL ENV PRESENCE</div>
                  <div className="text-xs space-y-1">
                    {Object.entries(debugInfo.presence).map(([key, ok]) => (
                      <div key={key} className="flex items-center justify-between py-0.5 border-b border-white/5 last:border-0">
                        <span className="text-white/70">{key}</span>
                        <span className={ok ? 'text-emerald-400' : 'text-red-400'}>{ok ? '✓' : '✕'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-white/40 px-1">
                {debugInfo.note} — Full raw JSON available via the Copy button above or <code className="font-mono">GET /api/debug/env</code>.
              </div>
            </div>
          )}
        </div>

        <div className="mt-10 text-xs text-white/50 border-t border-white/10 pt-6">
          This page is protected with the same password as the admin panel. It is intended for debugging during development and production incidents.
          Never share unmasked connection strings.
        </div>
      </div>
    </div>
  );
}

/* Small presentational helper for key-value rows */
function KV({ label, value, highlight, mono }: { label: string; value: string | undefined; highlight?: boolean; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-white/45 mb-0.5">{label}</div>
      <div className={`text-sm ${highlight ? 'font-semibold text-white' : 'text-white/80'} ${mono ? 'font-mono text-xs' : ''} break-all`}>
        {value || '—'}
      </div>
    </div>
  );
}
