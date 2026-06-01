"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { products, categories, brands, Product } from "@/lib/products";
import { wholeFoodsCategories } from "@/lib/categories";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";
import { toast } from "sonner";
import { FilterDrawer } from "../components/FilterDrawer";

export default function ProductsPage() {
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [activeSubcategories, setActiveSubcategories] = useState<string[]>([]);
  const [activeBrands, setActiveBrands] = useState<string[]>([]);

  // Collapsible state for Whole Foods sub-groups
  const [frutasOpen, setFrutasOpen] = useState(true);
  const [verdurasOpen, setVerdurasOpen] = useState(true);

  // Mobile filter drawer
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [minPrice, setMinPrice] = useState(0);
  const [maxPrice, setMaxPrice] = useState(1300);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"featured" | "price-low" | "price-high" | "rating">("featured");

  // Count how many products are in each subcategory
  const subcategoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    products.forEach((product) => {
      if (product.subcategory) {
        counts[product.subcategory] = (counts[product.subcategory] || 0) + 1;
      }
    });
    return counts;
  }, []);

  const activeFilterCount = useMemo(() => {
    let count = activeCategories.length + activeSubcategories.length + activeBrands.length;
    if (minPrice !== 0) count += 1;
    if (maxPrice !== 1300) count += 1;
    if (searchQuery.trim() !== "") count += 1;
    return count;
  }, [activeCategories, activeSubcategories, activeBrands, minPrice, maxPrice, searchQuery]);

  const filteredProducts = products
    .filter((product) => {
      const matchesCategory =
        activeCategories.length === 0 || activeCategories.includes(product.category);

      const matchesSubcategory =
        activeSubcategories.length === 0 ||
        (product.subcategory && activeSubcategories.includes(product.subcategory));

      const matchesBrand =
        activeBrands.length === 0 || activeBrands.includes(product.brand);
      const matchesPrice = product.price >= minPrice && product.price <= maxPrice;
      const matchesSearch =
        searchQuery === "" ||
        product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.brand.toLowerCase().includes(searchQuery.toLowerCase());

      return matchesCategory && matchesSubcategory && matchesBrand && matchesPrice && matchesSearch;
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
    setActiveCategories((prev) => {
      const isCurrentlyActive = prev.includes(cat);
      const newCategories = isCurrentlyActive
        ? prev.filter((c) => c !== cat)
        : [...prev, cat];

      // Clear subcategories if Whole Foods is deselected
      if (cat === "Whole Foods" && isCurrentlyActive) {
        setActiveSubcategories([]);
      }

      return newCategories;
    });
  };

  const toggleBrand = (brand: string) => {
    setActiveBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]
    );
  };

  // Shared filter controls rendered in both desktop sidebar and mobile drawer
  const FilterControls = () => (
    <>
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
            <div key={cat}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeCategories.includes(cat)}
                  onChange={() => toggleCategory(cat)}
                  className="accent-white"
                />
                {cat}
              </label>

              {/* Nested collapsible subcategories for Whole Foods */}
              {cat === "Whole Foods" && activeCategories.includes("Whole Foods") && (
                <div className="ml-6 mt-2 space-y-2 pl-2 border-l border-white/20">
                  {/* Frutas Group */}
                  <div>
                    <button
                      onClick={() => setFrutasOpen(!frutasOpen)}
                      className="flex w-full items-center justify-between text-left text-xs font-medium text-white/80 hover:text-white py-1"
                    >
                      <span>Frutas</span>
                      <span className="text-[10px]">{frutasOpen ? "−" : "+"}</span>
                    </button>
                    {frutasOpen && (
                      <div className="mt-1 ml-2 space-y-1">
                        {wholeFoodsCategories.subcategories?.[0]?.subcategories?.map((sub) => (
                          <label key={sub.id} className="flex items-center gap-2 text-xs cursor-pointer pl-1">
                            <input
                              type="checkbox"
                              checked={activeSubcategories.includes(sub.name)}
                              onChange={() => {
                                setActiveSubcategories((prev) =>
                                  prev.includes(sub.name)
                                    ? prev.filter((s) => s !== sub.name)
                                    : [...prev, sub.name]
                                );
                              }}
                              className="accent-white"
                            />
                            <span className="leading-tight">
                              {sub.name}{" "}
                              <span className="text-white/40">({subcategoryCounts[sub.name] || 0})</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Verduras Group */}
                  <div>
                    <button
                      onClick={() => setVerdurasOpen(!verdurasOpen)}
                      className="flex w-full items-center justify-between text-left text-xs font-medium text-white/80 hover:text-white py-1"
                    >
                      <span>Verduras</span>
                      <span className="text-[10px]">{verdurasOpen ? "−" : "+"}</span>
                    </button>
                    {verdurasOpen && (
                      <div className="mt-1 ml-2 space-y-1">
                        {wholeFoodsCategories.subcategories?.[1]?.subcategories?.map((sub) => (
                          <label key={sub.id} className="flex items-center gap-2 text-xs cursor-pointer pl-1">
                            <input
                              type="checkbox"
                              checked={activeSubcategories.includes(sub.name)}
                              onChange={() => {
                                setActiveSubcategories((prev) =>
                                  prev.includes(sub.name)
                                    ? prev.filter((s) => s !== sub.name)
                                    : [...prev, sub.name]
                                );
                              }}
                              className="accent-white"
                            />
                            <span className="leading-tight">
                              {sub.name}{" "}
                              <span className="text-white/40">({subcategoryCounts[sub.name] || 0})</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
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
          setActiveSubcategories([]);
          setActiveBrands([]);
          setMinPrice(0);
          setMaxPrice(1300);
          setSearchQuery("");
        }}
        className="text-xs text-white/50 hover:text-white underline"
      >
        Clear All Filters
      </button>
    </>
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-7xl mx-auto px-8 pt-10 pb-24">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50">DISCOVER</div>
            <h1 className="text-5xl tracking-tighter font-semibold">All Products</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/60">{filteredProducts.length} results</span>
            
            {/* Mobile Filter Button */}
            <button
              onClick={() => setIsFilterDrawerOpen(true)}
              className="lg:hidden flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-white/20 hover:bg-white/5 active:bg-white/10"
            >
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-black tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-10">
          {/* Filters Sidebar - Desktop only (kept as-is per requirements) */}
          <div className="hidden lg:block lg:w-72 space-y-8 shrink-0">
            <FilterControls />
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

        {/* Mobile Filter Drawer wired to shared FilterDrawer component */}
        <FilterDrawer
          isOpen={isFilterDrawerOpen}
          onClose={() => setIsFilterDrawerOpen(false)}
        >
          <FilterControls />
        </FilterDrawer>
      </div>
    </div>
  );
}
