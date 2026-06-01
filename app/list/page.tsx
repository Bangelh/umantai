"use client";

import { useState } from "react";
import Link from "next/link";
import { useShoppingListStore } from "@/lib/shoppingListStore";
import { useCartStore } from "@/lib/cartStore";
import { toast } from "sonner";

export default function ShoppingListPage() {
  const { 
    items, 
    removeItem, 
    toggleChecked, 
    updateQuantity, 
    updateNote, 
    clearList,
    reorderItems 
  } = useShoppingListStore();

  const [draggedId, setDraggedId] = useState<string | null>(null);

  // Print options
  const [printUncheckedOnly, setPrintUncheckedOnly] = useState(false);
  const [includePricesInPrint, setIncludePricesInPrint] = useState(true);

  const handlePrint = () => {
    window.print();
  };

  const checkedItems = items.filter(item => item.checked);
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

  // Group items by category
  const groupedItems = items.reduce((acc, item) => {
    const category = item.product.category;
    if (!acc[category]) acc[category] = [];
    acc[category].push(item);
    return acc;
  }, {} as Record<string, typeof items>);

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-6">📝</div>
          <h1 className="text-4xl tracking-tight mb-4">Your Shopping List is empty</h1>
          <p className="text-white/60 mb-8 max-w-md mx-auto">
            Add products from the collection to build your personalized Umantai shopping list.
          </p>
          <Link 
            href="/products" 
            className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-black font-medium hover:bg-white/90"
          >
            Browse Products
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-4xl mx-auto px-8 py-12 print:py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 print:mb-4">
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50">PLANNING</div>
            <h1 className="text-5xl tracking-tighter font-semibold">My Shopping List</h1>
            <p className="text-white/60 mt-1">{totalItems} items • Umantai 2026</p>
          </div>
          
          <div className="flex flex-col items-end gap-2 print:hidden">
            {/* Print Options */}
            <div className="flex gap-4 text-sm mb-1">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={printUncheckedOnly}
                  onChange={(e) => setPrintUncheckedOnly(e.target.checked)}
                  className="accent-white"
                />
                <span>Only unchecked</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePricesInPrint}
                  onChange={(e) => setIncludePricesInPrint(e.target.checked)}
                  className="accent-white"
                />
                <span>Include prices</span>
              </label>
            </div>

            {/* Bulk Actions */}
            <div className="flex gap-2 mb-1">
              <button
                onClick={() => {
                  if (checkedItems.length === 0) {
                    toast.info("No checked items to add");
                    return;
                  }
                  const cart = useCartStore.getState();
                  checkedItems.forEach(item => cart.addItem(item.product, item.quantity));
                  toast.success(`Added ${checkedItems.length} items to cart`);
                }}
                className="px-4 py-1 text-xs rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
              >
                Add checked to Cart
              </button>
            </div>

            {/* Print Buttons */}
            <div className="flex gap-3">
              <button 
                onClick={handlePrint}
                className="px-6 py-2 rounded-full border border-white/20 hover:bg-white/5 transition-colors flex items-center gap-2"
              >
                🖨️ Print List
              </button>
              <button 
                onClick={handlePrint}
                className="px-6 py-2 rounded-full bg-white text-black font-medium hover:bg-white/90 transition-colors flex items-center gap-2"
              >
                🖨️ Compact Print
              </button>
              <button 
                onClick={clearList}
                className="px-6 py-2 rounded-full border border-white/20 hover:bg-white/5 transition-colors text-red-400"
              >
                Clear All
              </button>
            </div>
          </div>
        </div>

        {/* Ready to Fulfill Section - Smart suggestions based on checked items */}
        {checkedItems.length > 0 && (
          <div className="mb-10 bg-neutral-900 border border-emerald-500/20 rounded-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-emerald-400 text-sm font-medium tracking-widest">SMART ACTIONS</div>
                <h2 className="text-2xl font-semibold tracking-tight">Ready to Fulfill</h2>
              </div>
              <div className="text-sm text-white/60 bg-neutral-800 px-3 py-1 rounded-full">
                {checkedItems.length} item{checkedItems.length > 1 ? 's' : ''} ready
              </div>
            </div>

            <p className="text-white/70 text-sm mb-6">
              You’ve checked these off. How would you like to receive them?
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Ready to Buy */}
              <button
                onClick={() => {
                  const cart = useCartStore.getState();
                  checkedItems.forEach(item => cart.addItem(item.product, item.quantity));
                  toast.success(`${checkedItems.length} items added to Cart`);
                }}
                className="flex flex-col items-start p-5 rounded-2xl border border-white/10 hover:border-emerald-400/40 bg-neutral-950 text-left transition-all active:scale-[0.985]"
              >
                <div className="text-lg font-semibold mb-1">🛒 Ready to Buy</div>
                <div className="text-sm text-white/70">Add to Cart for online purchase</div>
              </button>

              {/* Ready for Pickup */}
              <button
                onClick={() => {
                  toast.success(`Sent ${checkedItems.length} items for Pickup`, {
                    description: "You can collect them using the Kiosk at our SoHo store",
                  });
                }}
                className="flex flex-col items-start p-5 rounded-2xl border border-white/10 hover:border-emerald-400/40 bg-neutral-950 text-left transition-all active:scale-[0.985]"
              >
                <div className="text-lg font-semibold mb-1">📍 Ready for Pickup</div>
                <div className="text-sm text-white/70">Collect at our flagship store</div>
              </button>

              {/* Delivery */}
              <button
                onClick={() => {
                  toast.success(`Delivery requested for ${checkedItems.length} items`, {
                    description: "Our team will contact you shortly to schedule",
                  });
                }}
                className="flex flex-col items-start p-5 rounded-2xl border border-white/10 hover:border-emerald-400/40 bg-neutral-950 text-left transition-all active:scale-[0.985]"
              >
                <div className="text-lg font-semibold mb-1">🚚 Delivery</div>
                <div className="text-sm text-white/70">Have it delivered to you</div>
              </button>
            </div>
          </div>
        )}

        {/* List Items */}
        <div className="space-y-8 pb-20 md:pb-0">
          {Object.entries(groupedItems).map(([category, categoryItems]) => (
            <div key={category}>
              <h3 className="text-lg font-semibold tracking-tight mb-3 border-b border-white/10 pb-2 text-white/80">
                {category}
              </h3>
              <div className="space-y-3">
                {categoryItems.map((item) => (
                  <div 
                    key={item.id} 
                    draggable
                    onDragStart={(e) => {
                      setDraggedId(item.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedId && draggedId !== item.id) {
                        reorderItems(draggedId, item.id);
                      }
                      setDraggedId(null);
                    }}
                    onDragEnd={() => setDraggedId(null)}
                    className={`flex items-start gap-4 p-4 rounded-2xl border transition-all cursor-grab active:cursor-grabbing ${
                      item.checked 
                        ? "bg-neutral-900 border-white/5 opacity-60" 
                        : "bg-neutral-900 border-white/10"
                    } ${draggedId === item.id ? "opacity-50" : ""}`}
                  >
                    <button
                      onClick={() => toggleChecked(item.id)}
                      className={`mt-1 w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${
                        item.checked 
                          ? "bg-white border-white" 
                          : "border-white/30"
                      }`}
                    >
                      {item.checked && <span className="text-black text-xs">✓</span>}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3">
                        <div>
                          <div className="font-medium">{item.product.name}</div>
                          <div className="text-sm text-white/60">{item.product.brand}</div>
                        </div>
                        <div className="font-mono text-sm text-white/70 ml-auto">
                          ${item.product.price} × {item.quantity}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mt-2 text-sm">
                        <input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateQuantity(item.id, parseInt(e.target.value) || 1)}
                          className="w-14 bg-neutral-800 border border-white/20 rounded px-2 py-1 text-center"
                          min="1"
                        />
                        
                        <input
                          type="text"
                          value={item.note || ""}
                          onChange={(e) => updateNote(item.id, e.target.value)}
                          placeholder="Add note..."
                          className="flex-1 bg-neutral-800 border border-white/20 rounded px-3 py-1 text-sm placeholder:text-white/40"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 print:hidden">
                      <button 
                        onClick={() => {
                          useCartStore.getState().addItem(item.product, item.quantity);
                          toast.success(`Added ${item.product.name} to cart`);
                        }}
                        className="text-xs px-3 py-1 rounded-full bg-white text-black font-medium hover:bg-white/90 active:scale-[0.985] transition-all"
                      >
                        Add to Cart
                      </button>
                      <button 
                        onClick={() => removeItem(item.id)}
                        className="text-white/40 hover:text-red-400 text-xl leading-none"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="mt-8 pt-6 border-t border-white/10 flex justify-between items-center text-lg font-medium">
          <div>Total Items</div>
          <div className="font-mono">{totalItems}</div>
        </div>

        <div className="flex justify-between items-center text-xl font-semibold mt-1">
          <div>Estimated Total</div>
          <div className="font-mono">
            ${items.reduce((sum, item) => sum + item.product.price * item.quantity, 0).toFixed(2)}
          </div>
        </div>

        {/* Ultra Compact Print Version */}
        <div className="hidden print:block mt-4">
          <div className="text-[10pt] font-semibold mb-1">Umantai Shopping List</div>
          <div className="text-[8pt] text-gray-600 mb-2">
            {new Date().toLocaleDateString()} — {totalItems} items
          </div>

          {Object.entries(groupedItems).map(([category, categoryItems]) => {
            const filtered = printUncheckedOnly 
              ? categoryItems.filter(i => !i.checked) 
              : categoryItems;
            if (filtered.length === 0) return null;

            return (
              <div key={category} className="mb-1">
                <div className="text-[8.5pt] font-semibold border-b border-gray-400 pb-0.5 mb-0.5">
                  {category}
                </div>
                {filtered.map((item) => (
                  <div key={item.id} className="flex justify-between text-[8pt] leading-[1.05] py-px">
                    <span>
                      {item.checked ? "☑ " : "☐ "}
                      {item.product.brand} {item.product.name}
                      {item.note ? ` — ${item.note}` : ""}
                    </span>
                    {includePricesInPrint && (
                      <span className="font-mono whitespace-nowrap">
                        {item.quantity}× ${item.product.price}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          <div className="mt-2 pt-1 border-t text-[8.5pt] flex justify-between">
            <span>Total Items: {totalItems}</span>
            {includePricesInPrint && (
              <span className="font-mono">
                Total: ${items.reduce((sum, item) => sum + item.product.price * item.quantity, 0).toFixed(2)}
              </span>
            )}
          </div>
        </div>

        {/* Mobile Bottom Action Bar */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-white/10 px-4 py-3 flex gap-3 z-50">
          <button 
            onClick={() => window.print()}
            className="flex-1 py-3 rounded-xl border border-white/20 text-sm font-medium flex items-center justify-center gap-2 active:bg-white/5"
          >
            🖨️ Print List
          </button>
          <button 
            onClick={() => window.print()}
            className="flex-1 py-3 rounded-xl bg-white text-black text-sm font-medium flex items-center justify-center gap-2 active:bg-white/90"
          >
            Compact Print
          </button>
        </div>
      </div>
    </div>
  );
}
