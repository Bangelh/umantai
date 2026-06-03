import { buildConfig } from 'payload'
import type { Config } from './payload-types'
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

    // Brands - managed via Payload admin (/cms) or custom /admin for now
    {
      slug: 'brands',
      admin: {
        useAsTitle: 'name',
      },
      access: {
        read: () => true,
        create: ({ req }) => !!req.user,
        update: ({ req }) => !!req.user,
        delete: ({ req }) => !!req.user,
      },
      fields: [
        {
          name: 'name',
          type: 'text',
          required: true,
          unique: true,
        },
      ],
    },

    // Categories - hierarchical tree (parent relationship)
    // Supports the existing Frutas/Verduras structure + custom subs
    {
      slug: 'categories',
      admin: {
        useAsTitle: 'name',
      },
      access: {
        read: () => true,
        create: ({ req }) => !!req.user,
        update: ({ req }) => !!req.user,
        delete: ({ req }) => !!req.user,
      },
      hooks: {
        beforeChange: [
          ({ data, operation }) => {
            if ((operation === 'create' || operation === 'update') && data.name) {
              if (!data.slug) {
                data.slug = data.name
                  .toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^a-z0-9-]/g, '');
              }
              // Note: level calc on parent change would require async lookup of parent chain; left for follow-up or custom admin
            }
            return data;
          },
        ],
      },
      fields: [
        {
          name: 'name',
          type: 'text',
          required: true,
        },
        {
          name: 'slug',
          type: 'text',
          unique: true,
          admin: {
            description: 'Auto-generated from name on create (can be edited)',
          },
        },
        {
          name: 'parent',
          type: 'relationship',
          relationTo: 'categories',
          hasMany: false,
          admin: {
            description: 'Parent category for tree structure (null for top-level like Frutas, Verduras)',
          },
        },
        {
          name: 'level',
          type: 'number',
          defaultValue: 0,
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'sortOrder',
          type: 'number',
          defaultValue: 0,
        },
      ],
    },

    // Products - main product data (can replace or augment the hardcoded baseProductsData)
    // Brand and Category are relationships for proper typing and admin UX
    {
      slug: 'products',
      admin: {
        useAsTitle: 'name',
      },
      access: {
        read: () => true,
        create: ({ req }) => !!req.user,
        update: ({ req }) => !!req.user,
        delete: ({ req }) => !!req.user,
      },
      fields: [
        {
          name: 'slug',
          type: 'text',
          required: true,
          unique: true,
          admin: {
            description: 'URL-friendly identifier, e.g. iphone-15-pro-titanium',
          },
        },
        {
          name: 'name',
          type: 'text',
          required: true,
        },
        {
          name: 'brand',
          type: 'relationship',
          relationTo: 'brands',
          required: true,
        },
        {
          name: 'price',
          type: 'number',
          required: true,
          min: 0,
        },
        {
          name: 'category',
          type: 'relationship',
          relationTo: 'categories',
        },
        {
          name: 'subcategory',
          type: 'text',
          admin: {
            description: 'Subcategory name (e.g. Paltas, Naranja, Mandarina y Otros Cítricos)',
          },
        },
        {
          name: 'description',
          type: 'textarea',
        },
        {
          name: 'specs',
          type: 'array',
          fields: [
            {
              name: 'value',
              type: 'text',
            },
          ],
        },
        {
          name: 'inStock',
          type: 'number',
          defaultValue: 0,
          min: 0,
          admin: {
            description: 'Stock units. 0 = hidden from public listings (inventory control)',
          },
        },
        {
          name: 'rating',
          type: 'number',
          min: 0,
          max: 5,
          admin: {
            step: 0.1,
          },
        },
        {
          name: 'reviewCount',
          type: 'number',
          defaultValue: 0,
          min: 0,
        },
        {
          name: 'bestseller',
          type: 'checkbox',
          defaultValue: false,
        },
        {
          name: 'images',
          type: 'array',
          fields: [
            {
              name: 'url',
              type: 'text',
              admin: {
                description: 'Path like /images/products/xxx.jpg or full URL',
              },
            },
          ],
        },
        {
          name: 'colors',
          type: 'array',
          fields: [
            {
              name: 'value',
              type: 'text',
            },
          ],
        },
        {
          name: 'storage',
          type: 'array',
          fields: [
            {
              name: 'value',
              type: 'text',
            },
          ],
        },
      ],
    },

    // ProductOverrides - for the live "publish changes" system (price/stock/rename without full product edit)
    // This preserves the existing override pattern while giving typed Payload access
    {
      slug: 'product-overrides',
      admin: {
        useAsTitle: 'product',
      },
      access: {
        read: () => true,
        create: ({ req }) => !!req.user,
        update: ({ req }) => !!req.user,
        delete: ({ req }) => !!req.user,
      },
      fields: [
        {
          name: 'product',
          type: 'relationship',
          relationTo: 'products',
          required: true,
          unique: true,
          admin: {
            description: 'The base product this override applies to',
          },
        },
        {
          name: 'name',
          type: 'text',
        },
        {
          name: 'price',
          type: 'number',
        },
        {
          name: 'inStock',
          type: 'number',
        },
        {
          name: 'description',
          type: 'textarea',
        },
        {
          name: 'brand',
          type: 'relationship',
          relationTo: 'brands',
        },
        {
          name: 'category',
          type: 'relationship',
          relationTo: 'categories',
        },
        {
          name: 'subcategory',
          type: 'text',
        },
        {
          name: 'images',
          type: 'array',
          fields: [
            { name: 'url', type: 'text' },
          ],
        },
        {
          name: 'rating',
          type: 'number',
        },
        {
          name: 'reviewCount',
          type: 'number',
        },
        {
          name: 'bestseller',
          type: 'checkbox',
        },
        {
          name: 'published',
          type: 'checkbox',
          defaultValue: true,
          admin: {
            description: 'Whether this override is active (used by getAllProducts etc.)',
          },
        },
      ],
    },
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
