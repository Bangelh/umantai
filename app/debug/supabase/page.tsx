import { createClient } from '@/utils/supabase/server'
import { cookies } from 'next/headers'
import ClientDemo from './ClientDemo'

export default async function SupabaseDebugPage() {
  const cookieStore = await cookies()
  const supabase = createClient(cookieStore)

  // Example: try to select from an existing table (shopping_list_items or notes may exist after setup).
  // If no 'todos' table, this will gracefully show an error or empty.
  // For a real 'todos' table you would create it in Supabase with RLS policies.
  let data: any = null
  let error: any = null

  try {
    // Using a table that may exist in this project after running setup
    const result = await supabase.from('shopping_list_items').select('*').limit(5)
    data = result.data
    error = result.error
  } catch (e) {
    error = e
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Supabase SSR Debug</h1>
      <p className="mb-4 text-sm text-white/60">
        This page demonstrates the new <code>@supabase/ssr</code> clients created in <code>utils/supabase/</code>.
        The server client (above) uses cookies for session handling (refreshed via middleware).
        The component below shows live client-side usage with <code>createBrowserClient</code>.
      </p>

      <div className="bg-neutral-900 border border-white/10 rounded-xl p-6 mb-6">
        <h2 className="font-semibold mb-2">Server Client Test (from Server Component)</h2>
        {error ? (
          <div className="text-red-400">
            <p>Error: {error.message || String(error)}</p>
            <p className="text-xs mt-2">This is expected if the table doesn't exist or RLS blocks anon access. Run Setup in /admin and ensure proper policies.</p>
          </div>
        ) : data ? (
          <pre className="text-xs overflow-auto bg-black/50 p-3 rounded">{JSON.stringify(data, null, 2)}</pre>
        ) : (
          <p>No data (table may be empty or not created yet).</p>
        )}
      </div>

      <div className="mt-4">
        <ClientDemo />
      </div>

      <p className="mt-6 text-xs text-white/40">
        Middleware at root now calls updateSession on every request to keep Supabase Auth sessions fresh.
      </p>
    </div>
  )
}
