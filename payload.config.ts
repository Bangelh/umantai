import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { fileURLToPath } from 'url'

// Use the existing project's DB connection preference (non-pooling for reliability)
const getDatabaseConnectionString = () =>
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.SUPABASE_URL // fallback if someone uses Supabase direct, but prefer Postgres strings

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    // user defaults to 'users' which Payload auto-creates for authentication
  },
  // Use /cms to avoid conflict with the existing custom /admin panel.
  // Note: in Payload v3 the admin route is configured at the root `routes.admin`, not under `admin.path`.
  routes: {
    admin: '/cms',
  },
  collections: [
    // Built-in Users collection is added automatically for auth.
    // Example collection - Notes (to complement the existing /admin/notes feature)
    {
      slug: 'notes',
      admin: {
        useAsTitle: 'title',
      },
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
        },
        {
          name: 'content',
          type: 'richText',
          editor: lexicalEditor({}),
        },
        {
          name: 'published',
          type: 'checkbox',
          defaultValue: false,
        },
      ],
    },
    // You can add more collections here to match your products/brands etc.
    // For full e-commerce CMS, define Product, Brand, Category collections.
  ],
  editor: lexicalEditor({}),
  secret: process.env.PAYLOAD_SECRET || '',
  db: postgresAdapter({
    pool: {
      connectionString: getDatabaseConnectionString(),
    },
  }),
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  // Add any plugins here if needed
})
