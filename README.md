This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deployment

### Continuous Deployment (Recommended)

**GitHub → Vercel + Cloudflare Pages** for automatic live deploys on every push to `main`.

1. **Vercel**
   - Go to [vercel.com/new](https://vercel.com/new) → Import Git Repository → select `Bangelh/umantai`.
   - Framework: **Next.js**
   - Build Command: `npm run build`
   - Output Directory: `.next` (or blank)
   - **Environment Variables** (critical - use **DIRECT** connection strings, never pooled):
     - `POSTGRES_URL_NON_POOLING` (Direct connection from Supabase/Neon dashboard, port 5432)
     - `PAYLOAD_SECRET`
     - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `NEXT_PUBLIC_SERVER_URL=https://umantai.com` (or your domain)
     - Any `BANGELH_*` or `UMANTAI_URL_*` prefixed variants for Vercel integrations.
   - Once imported, **every push to `main`** triggers a production deploy automatically. PRs get preview URLs.

2. **Cloudflare Pages (OpenNext)**
   - Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Pages → Create a project → Connect to Git → select the `Bangelh/umantai` repo.
   - Build command: `npm run build:cloudflare`
   - Build output directory: `.open-next`
   - Environment Variables: Same as Vercel above (use direct DB).
   - **Important**: Always use `npm run build:cloudflare` (not plain `npm run build`).
   - Auto deploys on push to `main`. Use `npm run preview` locally with wrangler.

3. **Payload CMS**
   - Admin UI lives at `/cms` (deployed as part of the Next.js app).
   - Run migrations as part of CD: `npm run payload:migrate` (requires production `POSTGRES_URL_NON_POOLING` + `PAYLOAD_SECRET`).
   - See `.github/workflows/ci-cd.yml` for example job.
   - Generate types locally: `npm run payload:generate-types`

4. **Prisma / DB**
   - Not a primary direct dependency (uses `@neondatabase/serverless` + Payload postgres adapter).
   - Always prefer `POSTGRES_URL_NON_POOLING` (direct) for serverless reliability. See `lib/env.ts` and `lib/db.ts`.
   - The CI/CD workflow and `EnvironmentStatus` will warn loudly if a pooled URL is detected.

### Local / Manual Deploy Commands

```bash
# Setup
git remote set-url origin https://github.com/Bangelh/umantai.git
git push origin main

# Vercel
npx vercel login
npx vercel link          # link to your project
npx vercel --prod        # manual production deploy

# Cloudflare
npm run build:cloudflare
npm run deploy:cloudflare   # or: npx wrangler pages deploy .open-next --project-name=umantai

# Payload
npm run payload:generate-types
npm run payload:migrate     # run against your current DB (use prod env for production DB)

# Full local Cloudflare preview
npm run preview
```

### GitHub Actions (CI + optional custom deploys)

See `.github/workflows/ci-cd.yml` (pushed with this setup):
- Runs on every push/PR: install, Payload types, lint, build (Next.js + Cloudflare).
- Example jobs for CLI-based deploys to Vercel/Cloudflare (enable by adding secrets: `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`, prod DB secrets, etc.).
- Add a job to run `payload:migrate` against production before/after deploys.

**Secrets to add in GitHub (repo Settings → Secrets and variables → Actions)** if using the CLI deploy jobs:
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Production DB: `PROD_POSTGRES_URL_NON_POOLING` (direct!), `PAYLOAD_SECRET`, Supabase keys, etc.

### Grok Build / Agent Integration (this environment)

- Use natural language: "deploy to vercel", "run npm run deploy:cloudflare", "create GitHub release", "set up Cloudflare Pages project".
- Available tools: `run_terminal_command` (vercel, wrangler, gh CLI already authenticated as Bangelh in many sessions), `gh` for repo/PR management.
- Skills: Use `/implement`, `/pr-babysit`, `review` for code + deploy PRs. No dedicated Vercel/Cloudflare MCP skill was present, but terminal + CLIs provide direct control.
- For "Build directly": the agent can execute the exact build/deploy commands above in this shell.

### Important Notes for umantai.com

- **Non-pooling DB**: The code strictly prefers `POSTGRES_URL_NON_POOLING`. The current `.env.local` had a pooled value under that name — always use the **Direct connection** string.
- Automatic deploys will only be reliable once the Git integrations are connected in Vercel + Cloudflare dashboards and secrets are correct.
- Test a push after connecting the platforms — it should trigger live deploys to both.

Push this README update + workflow, then connect the dashboards. Every future `git push origin main` will build + (via platform hooks) deploy live.
