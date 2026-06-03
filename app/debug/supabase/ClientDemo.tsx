'use client'

import { useState } from 'react'
import { createClient } from '@/utils/supabase/client'

export default function ClientDemo() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    setData(null)

    try {
      const supabase = createClient()

      // Try a table that exists after setup (shopping_list_items)
      // This will use the anon key from the browser client.
      // If RLS blocks it or table missing, it will error (expected until policies are set).
      const result = await supabase
        .from('shopping_list_items')
        .select('*')
        .limit(5)

      if (result.error) {
        setError(result.error.message)
      } else {
        setData(result.data)
      }
    } catch (e: any) {
      setError(e.message || 'Unexpected client error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border border-white/10 rounded-xl p-6 bg-neutral-900">
      <h2 className="font-semibold mb-3">Client Component Demo</h2>
      <p className="text-sm text-white/60 mb-4">
        This uses <code>import {'{ createClient }'} from '@/utils/supabase/client'</code> in a <code>'use client'</code> component.
      </p>

      <button
        onClick={fetchData}
        disabled={loading}
        className="px-4 py-2 rounded-xl bg-white text-black text-sm disabled:opacity-50 mb-4"
      >
        {loading ? 'Fetching...' : 'Fetch from Supabase (client-side)'}
      </button>

      {error && (
        <div className="text-red-400 text-sm mb-2">
          Error: {error}
          <div className="text-xs mt-1 text-white/50">
            Common: table missing, RLS policy blocking anon, or no data.
            Use /admin → Setup DB Tables, then configure RLS in Supabase dashboard if needed.
          </div>
        </div>
      )}

      {data && (
        <pre className="text-xs bg-black/60 p-3 rounded overflow-auto max-h-48">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

      {!data && !error && !loading && (
        <p className="text-xs text-white/50">Click the button to test client-side Supabase query.</p>
      )}
    </div>
  )
}
