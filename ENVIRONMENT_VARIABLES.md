# Umantai - Environment Variables

> **Recommended**: Use the helper at `lib/env.ts` for type-safe access to these variables throughout the app.

## Using the Helper

Instead of accessing `process.env` directly, import from the helper:

```ts
import { envConfig } from '@/lib/env';

// Example usage
console.log(envConfig.supabase.url);
console.log(envConfig.whatsapp.salesPhone);
console.log(envConfig.vercel.isProduction);
```

This gives you:
- Full TypeScript support
- Automatic fallback handling for Vercel integration prefixes (BANGELH_ from Bangelh, UMANTAI_URL_ from umantai vercel deploys e.g. umantai-dh4a-7zlzja1br-umantai.vercel.app, plus NEXT_PUBLIC_ insertion variants)
- Clear validation errors when variables are missing in production

This document lists all recommended environment variables for deploying Umantai on Vercel.

## Important Notes

- **Prefix support**: The code supports multiple Vercel/Supabase integration prefixes:
  - `BANGELH_*` / `BANGELH_NEXT_PUBLIC_*` — from Bangelh-linked Supabase integration
  - `UMANTAI_URL_*` / `NEXT_PUBLIC_UMANTAI_URL_*` — injected by umantai Vercel project (e.g. preview URLs like umantai-dh4a-7zlzja1br-umantai.vercel.app)
  - Plus direct (unprefixed) names always work as fallback.
- Vercel Postgres variables are usually auto-injected when you connect a Postgres database (prefixed variants also resolved).
- `SUPABASE_SERVICE_ROLE_KEY` is required for server-side operations (especially the Notes feature due to Row Level Security).

---

## Production

### Supabase
```env
# Main Supabase project URL (with custom prefix - any supported)
BANGELH_NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
# or UMANTAI_URL_NEXT_PUBLIC_SUPABASE_URL=... (or NEXT_PUBLIC_UMANTAI_URL_SUPABASE_URL=...)

# Public anon key (safe for client-side)
BANGELH_NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

# Secret Service Role Key (server-only, bypasses RLS)
BANGELH_SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Fallbacks (standard names without prefix) — always supported
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### WhatsApp
```env
# Sales WhatsApp number (used in FloatingWhatsApp component)
NEXT_PUBLIC_WHATSAPP_SALES_PHONE=51981177931

# Support WhatsApp number
NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE=51934947258

# Default message when opening Sales WhatsApp
NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE=Hello! I'd like to know more about your products.

# Default message when opening Support WhatsApp
NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE=Hello! I need help with my order or account.
```

### Vercel Postgres
```env
# Main connection string (often pooled)
POSTGRES_URL=postgres://...

# Recommended for Prisma ORM
POSTGRES_PRISMA_URL=postgres://...

# Direct (non-pooled) connection - strongly recommended for local dev
POSTGRES_URL_NON_POOLING=postgres://...

POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_HOST=...
POSTGRES_DATABASE=...
```

### Additional / Recommended
```env
# Current environment (production, preview, development)
# Very useful for conditional logic
VERCEL_ENV=production

# Public URL of the current deployment (useful for absolute URLs, webhooks, etc.)
VERCEL_URL=your-project.vercel.app
```

---

## Preview

### Supabase
```env
BANGELH_NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
BANGELH_NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
BANGELH_SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### WhatsApp
```env
NEXT_PUBLIC_WHATSAPP_SALES_PHONE=51981177931
NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE=51934947258
NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE=Hello! I'd like to know more about your products.
NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE=Hello! I need help with my order or account.
```

### Vercel Postgres
```env
POSTGRES_URL=postgres://...
POSTGRES_PRISMA_URL=postgres://...
POSTGRES_URL_NON_POOLING=postgres://...
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_HOST=...
POSTGRES_DATABASE=...
```

### Additional
```env
VERCEL_ENV=preview
VERCEL_URL=your-project-git-branch.vercel.app
```

---

## Development

### Supabase
```env
BANGELH_NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
BANGELH_NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
BANGELH_SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### WhatsApp
```env
NEXT_PUBLIC_WHATSAPP_SALES_PHONE=51981177931
NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE=51934947258
NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE=Hello! I'd like to know more about your products.
NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE=Hello! I need help with my order or account.
```

### Vercel Postgres
```env
POSTGRES_URL=postgres://...
POSTGRES_PRISMA_URL=postgres://...
POSTGRES_URL_NON_POOLING=postgres://...
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_HOST=...
POSTGRES_DATABASE=...
```

### Additional
```env
VERCEL_ENV=development
```

---

## Summary of Recommended Additions

| Variable                        | Why It's Useful                                      | Recommended For |
|--------------------------------|------------------------------------------------------|-----------------|
| `VERCEL_ENV`                   | Detect runtime environment (prod/preview/dev)        | All             |
| `VERCEL_URL`                   | Get the public URL of the current deployment         | All             |
| `POSTGRES_URL_NON_POOLING`     | More reliable direct connection for local dev        | Development     |
| `BANGELH_*` / `UMANTAI_URL_*` prefixed keys | Match Supabase integration prefix (Bangelh or umantai vercel pulls) | All             |

---

Let me know if you want any of these added to the code (for example, a small utility to read `VERCEL_ENV` safely) or if you'd like a minimal production-only version.