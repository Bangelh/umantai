/**
 * Seed script for the new Payload collections (brands, categories, products, product-overrides).
 * Run with: npx tsx scripts/seed-payload-collections.ts
 *
 * This populates Payload from:
 * - lib/categories.ts (wholeFoodsCategories tree)
 * - lib/products.ts (baseProductsData)
 * - Current overrides from the custom system (if DB connected)
 *
 * After running, you can manage everything via /cms (Payload admin).
 * The custom /admin can later be updated or deprecated in favor of Payload.
 */

import { getPayload } from 'payload'
import config from '../payload.config'
import { wholeFoodsCategories } from '../lib/categories'
import { baseProductsData as baseProducts } from '../lib/products'
import { getAllOverrides } from '../lib/db'

async function seed() {
  console.log('🚀 Starting Payload collections seed...')

  const payload = await getPayload({ config })

  // 1. Seed Brands (from unique brands in base products + any overrides)
  console.log('\n📦 Seeding brands...')
  const brandNames = new Set<string>()
  baseProducts.forEach(p => brandNames.add(p.brand))
  // Also pull from overrides if any
  try {
    const overrides = await getAllOverrides()
    Object.values(overrides).forEach((ov: any) => {
      if (ov.brand) brandNames.add(ov.brand)
    })
  } catch {}

  let brandsCreated = 0
  for (const name of brandNames) {
    const existing = await payload.find({
      collection: 'brands',
      where: { name: { equals: name } },
      limit: 1,
    })
    if (existing.docs.length === 0) {
      await payload.create({
        collection: 'brands',
        data: { name },
      })
      brandsCreated++
      console.log(`  + ${name}`)
    }
  }
  console.log(`  Seeded ${brandsCreated} new brands (total unique: ${brandNames.size})`)

  // 2. Seed Categories (recursive from wholeFoodsCategories)
  console.log('\n📁 Seeding categories tree...')
  const createdCategoryIds = new Map<string, number>() // name -> id

  async function seedCategory(node: any, parentId?: number, level = 0) {
    const name = node.name
    if (!name) return

    // Check if exists by name + parent
    const where: any = { name: { equals: name } }
    if (parentId) where.parent = { equals: parentId }

    const existing = await payload.find({
      collection: 'categories',
      where,
      limit: 1,
    })

    let catId: number
    if (existing.docs.length > 0) {
      catId = existing.docs[0].id
    } else {
      const created = await payload.create({
        collection: 'categories',
        data: {
          name,
          parent: parentId || undefined,
          level,
          sortOrder: 0,
        },
      })
      catId = created.id
      console.log(`  + ${'  '.repeat(level)}${name}`)
    }
    createdCategoryIds.set(name, catId)

    if (node.subcategories) {
      for (const sub of node.subcategories) {
        await seedCategory(sub, catId, level + 1)
      }
    }
  }

  // Seed top level "Whole Foods" structure (Frutas + Verduras groups)
  if (wholeFoodsCategories.subcategories) {
    for (const group of wholeFoodsCategories.subcategories) {
      await seedCategory(group, undefined, 0)
    }
  }
  console.log('  Categories tree seeded (or already existed)')

  // 3. Seed Products + apply current overrides
  console.log('\n🛍️  Seeding products (base + current overrides)...')
  const overrides = await getAllOverrides().catch(() => ({} as any))

  let productsCreated = 0
  let overridesCreated = 0

  for (const base of baseProducts) {
    // Find brand id
    const brandDoc = await payload.find({
      collection: 'brands',
      where: { name: { equals: base.brand } },
      limit: 1,
    })
    const brandId = brandDoc.docs[0]?.id

    // Find category id (best effort - match by subcategory or category name)
    let categoryId: number | undefined
    const subName = base.subcategory
    if (subName && createdCategoryIds.has(subName)) {
      categoryId = createdCategoryIds.get(subName)
    } else if (createdCategoryIds.has(base.category)) {
      categoryId = createdCategoryIds.get(base.category)
    }

    const existingProduct = await payload.find({
      collection: 'products',
      where: { slug: { equals: base.slug } },
      limit: 1,
    })

    let productId: number
    if (existingProduct.docs.length > 0) {
      productId = existingProduct.docs[0].id
    } else {
      const created = await payload.create({
        collection: 'products',
        data: {
          slug: base.slug,
          name: base.name,
          brand: brandId,
          price: base.price,
          category: categoryId,
          subcategory: base.subcategory,
          description: base.description,
          specs: base.specs?.map(s => ({ value: s })) || [],
          inStock: base.inStock,
          rating: base.rating,
          reviewCount: base.reviewCount,
          bestseller: base.bestseller || false,
          images: base.images?.map(i => ({ url: i })) || [],
          colors: base.colors?.map(c => ({ value: c })) || [],
          storage: base.storage?.map(s => ({ value: s })) || [],
        },
      })
      productId = created.id
      productsCreated++
      console.log(`  + ${base.slug}`)
    }

    // Apply override if exists
    const ov = overrides[base.slug]
    if (ov) {
      const existingOverride = await payload.find({
        collection: 'product-overrides',
        where: { product: { equals: productId } },
        limit: 1,
      })

      if (existingOverride.docs.length === 0) {
        await payload.create({
          collection: 'product-overrides',
          data: {
            product: productId,
            name: ov.name,
            price: ov.price,
            inStock: ov.inStock,
            description: ov.description,
            subcategory: ov.subcategory,
            bestseller: ov.bestseller,
            published: true,
            // brand / category would require looking up ids again if needed
          },
        })
        overridesCreated++
      }
    }
  }

  console.log(`  Seeded ${productsCreated} new products + applied ${overridesCreated} overrides`)

  console.log('\n✅ Seed complete!')
  console.log('   You can now manage brands/categories/products/overrides in the Payload admin at /cms')
  console.log('   Run `npx payload generate:types` again if you changed anything.')
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
