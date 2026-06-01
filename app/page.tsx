import Link from "next/link";
import { getBestsellers, categories } from "@/lib/products";

export default function UmantaiHome() {
  const bestsellers = getBestsellers(4);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Hero */}
      <div className="relative min-h-[92vh] flex items-center justify-center border-b border-white/10">
        <div className="max-w-5xl px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1 rounded-full bg-white/10 text-sm mb-6 tracking-[2px]">
            NEW YORK • SAN FRANCISCO • COMING SOON
          </div>

          <h1 className="text-[92px] leading-[0.86] tracking-[-6.4px] font-semibold mb-4">
            Considered.<br />Curated.<br />Exceptional.
          </h1>

          <p className="max-w-xl mx-auto text-2xl text-white/80 tracking-tight mb-10">
            Premium whole foods and technology, brought together with care.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link 
              href="/products" 
              className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-white px-10 text-base font-medium text-black hover:bg-white/90 transition-colors"
            >
              Explore the Collection
            </Link>
            <Link 
              href="/kiosk" 
              className="inline-flex h-14 items-center justify-center rounded-full border border-white/40 px-10 text-base font-medium hover:bg-white/10 transition-colors"
            >
              Try the Pickup Kiosk
            </Link>
          </div>

          <div className="mt-16 flex items-center justify-center gap-8 text-xs tracking-[2px] text-white/50">
            <div>Carbon Negative</div>
            <div>Regenerative Sourcing</div>
            <div>Same-Day Delivery</div>
          </div>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/40 text-xs tracking-[3px]">
          SCROLL TO DISCOVER
        </div>
      </div>

      {/* Categories */}
      <div className="max-w-7xl mx-auto px-8 py-20">
        <div className="flex items-center justify-between mb-9">
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50 mb-1">DISCOVER</div>
            <h2 className="text-4xl font-semibold tracking-tight">Shop by category</h2>
          </div>
          <Link href="/products" className="text-sm text-white/70 hover:text-white">View all →</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {["Whole Foods", "Smartphones", "Wearables", "Smart Home"].map((cat, index) => (
            <Link 
              key={index}
              href={`/products?category=${encodeURIComponent(cat)}`}
              className="group block border border-white/10 bg-neutral-900 p-8 rounded-3xl hover:border-white/30 transition-colors"
            >
              <div className="text-2xl font-semibold tracking-tight mb-2">{cat}</div>
              <div className="text-white/60 text-sm mb-6">
                {cat === "Whole Foods" && "18 products"}
                {cat === "Smartphones" && "12 products"}
                {cat === "Wearables" && "14 products"}
                {cat === "Smart Home" && "9 products"}
              </div>
              <div className="text-sm text-white/70 group-hover:text-white transition-colors">
                SHOP CATEGORY →
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Bestsellers */}
      <div className="border-t border-white/10 bg-neutral-900/50">
        <div className="max-w-7xl mx-auto px-8 py-20">
          <div className="flex items-end justify-between mb-9">
            <div>
              <div className="uppercase tracking-[3px] text-xs text-white/50 mb-1">CURATED FOR YOU</div>
              <h2 className="text-4xl font-semibold tracking-tight">Bestsellers this week</h2>
            </div>
            <Link href="/products" className="text-sm text-white/70 hover:text-white hidden md:block">
              See all bestsellers →
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {bestsellers.map((product) => (
              <Link 
                key={product.slug} 
                href={`/products/${product.slug}`}
                className="group block border border-white/10 bg-neutral-900 p-6 rounded-3xl hover:border-white/30 transition-all"
              >
                <div className="aspect-[4/3] bg-neutral-800 rounded-2xl mb-6 flex items-center justify-center text-6xl">
                  {product.brand === "Apple" && "📱"}
                  {product.brand === "Dyson" && "🌀"}
                  {product.brand === "Oura" && "💍"}
                  {product.brand === "Peak Design" && "🎒"}
                  {!["Apple", "Dyson", "Oura", "Peak Design"].includes(product.brand) && "✨"}
                </div>
                
                <div className="text-sm text-white/60">{product.brand}</div>
                <div className="text-xl font-semibold tracking-tight mt-1 mb-4">{product.name}</div>
                
                <div className="flex items-center justify-between">
                  <div className="font-mono text-xl tracking-tighter">${product.price}</div>
                  <div className="text-sm text-white/60 group-hover:text-white transition-colors">View →</div>
                </div>
              </Link>
            ))}
          </div>

          <div className="text-center mt-10 md:hidden">
            <Link href="/products" className="text-sm text-white/70 hover:text-white">
              See all bestsellers →
            </Link>
          </div>
        </div>
      </div>

      {/* Flagship Experience */}
      <div className="border-t border-white/10">
        <div className="max-w-4xl mx-auto px-8 py-24 text-center">
          <div className="uppercase tracking-[3px] text-xs text-white/50 mb-3">FLAGSHIP EXPERIENCE</div>
          <h2 className="text-5xl tracking-[-1.5px] font-semibold mb-4">
            Visit us in SoHo.<br />Or skip the line.
          </h2>
          <p className="text-xl text-white/70 max-w-md mx-auto mb-10">
            Use our signature Ready for Pickup kiosk and be on your way in under two minutes.
          </p>
          
          <Link 
            href="/kiosk"
            className="inline-flex h-14 items-center justify-center rounded-full bg-white px-10 text-base font-medium text-black hover:bg-white/90 transition-colors"
          >
            Launch the Kiosk Experience
          </Link>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10 py-8 text-center text-xs text-white/50">
        © {new Date().getFullYear()} Umantai. New York &amp; San Francisco.
      </footer>
    </div>
  );
}
