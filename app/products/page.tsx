"use client";

import { useState } from "react";
import Link from "next/link";
import { products, categories, brands, Product } from "@/lib/products";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";
import { toast } from "sonner";

export default function ProductsPage() {
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [minPrice, setMinPrice] = useState(0);
  const [maxPrice, setMaxPrice] = useState(1300);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"featured" | "price-low" | "price-high" | "rating">("featured");

  const filteredProducts = products
    .filter((product) => {
      const matchesCategory =
        activeCategories.length === 0 || activeCategories.includes(product.category);
      const matchesBrand =
        activeBrands.length === 0 || activeBrands.includes(product.brand);
      const matchesPrice = product.price >= minPrice && product.price <= maxPrice;
      const matchesSearch =
        searchQuery === "" ||
        product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.brand.toLowerCase().includes(searchQuery.toLowerCase());

      return matchesCategory && matchesBrand && matchesPrice && matchesSearch;
    })
    .sort((a, b) => {
      if (sortMode === "price-low") return a.price - b.price;
      if (sortMode === "price-high") return b.price - a.price;
      if (sortMode === "rating") return b.rating - a.rating;
      // Featured: bestsellers first
      if (a.bestseller && !b.bestseller) return -1;
      if (!a.bestseller && b.bestseller) return 1;
      return 0;
    });

  const toggleCategory = (cat: string) => {
    setActiveCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const toggleBrand = (brand: string) => {
    setActiveBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]
    );
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-7xl mx-auto px-8 pt-10 pb-24">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50">DISCOVER</div>
            <h1 className="text-5xl tracking-tighter font-semibold">All Products</h1>
          </div>
          <div className="text-sm text-white/60">{filteredProducts.length} results</div>
        </div>

        <div className="flex flex-col lg:flex-row gap-10">
          {/* Filters Sidebar */}
          <div className="lg:w-72 space-y-8 shrink-0">
            {/* Search */}
            <div>
              <div className="font-medium mb-3 tracking-tight">Search</div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search products or brands..."
                className="w-full bg-neutral-900 border border-white/20 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white/40"
              />
            </div>

            {/* Categories */}
            <div>
              <div className="font-medium mb-4 tracking-tight">Categories</div>
              <div className="space-y-2 text-sm">
                {categories.map((cat) => (
                  <label key={cat} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeCategories.includes(cat)}
                      onChange={() => toggleCategory(cat)}
                      className="accent-white"
                    />
                    {cat}
                  </label>
                ))}
              </div>
            </div>

            {/* Brands */}
            <div>
              <div className="font-medium mb-4 tracking-tight">Brands</div>
              <div className="space-y-2 text-sm max-h-64 overflow-auto">
                {brands.map((brand) => (
                  <label key={brand} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeBrands.includes(brand)}
                      onChange={() => toggleBrand(brand)}
                      className="accent-white"
                    />
                    {brand}
                  </label>
                ))}
              </div>
            </div>

            {/* Price Range */}
            <div>
              <div className="font-medium mb-3 tracking-tight">Price Range</div>
              <div className="flex items-center gap-3 text-sm">
                <input
                  type="number"
                  value={minPrice}
                  onChange={(e) => setMinPrice(Number(e.target.value))}
                  className="w-20 bg-neutral-900 border border-white/20 rounded px-2 py-1"
                />
                <span className="text-white/50">to</span>
                <input
                  type="number"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(Number(e.target.value))}
                  className="w-20 bg-neutral-900 border border-white/20 rounded px-2 py-1"
                />
              </div>
            </div>

            <button
              onClick={() => {
                setActiveCategories([]);
                setActiveBrands([]);
                setMinPrice(0);
                setMaxPrice(1300);
                setSearchQuery("");
              }}
              className="text-xs text-white/50 hover:text-white underline"
            >
              Clear All Filters
            </button>
          </div>

          {/* Products Grid */}
          <div className="flex-1">
            {/* Sort Controls */}
            <div className="flex items-center justify-between mb-6 text-sm">
              <div className="text-white/60">Featured</div>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as any)}
                className="bg-neutral-900 border border-white/20 rounded px-3 py-1 text-sm"
              >
                <option value="featured">Featured</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
                <option value="rating">Highest Rated</option>
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {filteredProducts.length > 0 ? (
                filteredProducts.map((product) => (
                  <Link
                    key={product.slug}
                    href={`/products/${product.slug}`}
                    className="group block border border-white/10 bg-neutral-900 rounded-3xl p-6 hover:border-white/30 transition-all"
                  >
                    <div className="aspect-[4/3] bg-neutral-800 rounded-2xl mb-5 flex items-center justify-center text-6xl relative">
                      {product.bestseller && (
                        <div className="absolute top-4 left-4 text-[10px] px-3 py-1 bg-white text-black rounded-full tracking-widest">
                          Bestseller
                        </div>
                      )}
                      <div>
                        {product.brand === "Apple" && "📱"}
                        {product.brand === "Dyson" && "🌀"}
                        {product.brand === "Oura" && "💍"}
                        {product.brand === "Peak Design" && "🎒"}
                        {product.brand === "Bose" && "🎧"}
                        {product.brand === "Samsung" && "📱"}
                        {product.brand === "Whoop" && "⌚"}
                        {product.brand === "Sonos" && "🔊"}
                        {product.brand === "Anker" && "🔋"}
                        {product.brand === "Blue Bottle" && "☕"}
                        {product.brand === "Patagonia" && "🐟"}
                        {product.brand === "Google" && "📱"}
                      </div>
                    </div>

                    <div className="text-xs text-white/60">{product.brand}</div>
                    <div className="text-xl font-semibold tracking-tight mt-1 leading-tight">
                      {product.name}
                    </div>

                    <div className="mt-6 flex items-center justify-between">
                      <div className="font-mono text-2xl tracking-[-1px]">${product.price}</div>
                      <div className="flex gap-2">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            useCartStore.getState().addItem(product);
                            toast.success(`Added ${product.name} to cart`);
                          }}
                          className="text-sm px-4 py-1 rounded-full border border-white/20 hover:bg-white/5 transition-colors"
                        >
                          Add to Cart
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            useShoppingListStore.getState().addItem(product);
                            toast.success(`Added to Shopping List`);
                          }}
                          className="text-sm px-4 py-1 rounded-full bg-white text-black hover:bg-white/90 transition-colors"
                        >
                          + List
                        </button>
                      </div>
                    </div>
                  </Link>
                ))
              ) : (
                <div className="col-span-3 py-20 text-center text-white/60">
                  No products match your filters.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
