"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { baseProductsData, getProductOptions } from "@/lib/products";
import { buildVariantKey, enumerateVariantSelections } from "@/lib/commerce";
import { setAdminToken, withAdminAuth } from "@/lib/adminAuth";

/**
 * /admin/inventario — operación de stock de la tienda:
 *   · ver el inventario real (`inventory`) y las alertas de stock bajo;
 *   · registrar el INGRESO de mercadería (movimiento `receipt`).
 *
 * El stock se lee y escribe por las APIs de servidor (`/api/admin/inventory`), que
 * exigen el token de administración. La página nunca toca la base directamente.
 *
 * El token se pide al abrir y se valida contra la propia API (igual que la puerta del
 * kiosco): si no vale, no se muestra el panel.
 */

interface InventoryItem {
  productSlug: string;
  variantKey: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
  reorderPoint: number;
  isActive: boolean;
}

interface InventoryPayload {
  ok: boolean;
  items?: InventoryItem[];
  lowStock?: InventoryItem[];
  error?: string;
}

export default function InventoryAdminPage() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [lowStock, setLowStock] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Formulario de ingreso
  const [productSlug, setProductSlug] = useState(baseProductsData[0]?.slug ?? "");
  const [variantKey, setVariantKey] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reorderPoint, setReorderPoint] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const selectedProduct = useMemo(
    () => baseProductsData.find((product) => product.slug === productSlug),
    [productSlug],
  );

  const variantChoices = useMemo(() => {
    if (!selectedProduct) return [{ key: "", label: "sin variante" }];
    const options = getProductOptions(selectedProduct);
    if (options.length === 0) return [{ key: "", label: "sin variante" }];
    return enumerateVariantSelections(options).map((selection) => ({
      key: buildVariantKey(selection),
      label: Object.values(selection).filter(Boolean).join(" · ") || "sin variante",
    }));
  }, [selectedProduct]);

  // Variante efectiva: si la elegida no pertenece al producto actual, se usa la primera.
  const effectiveVariantKey = useMemo(() => {
    if (variantChoices.some((choice) => choice.key === variantKey)) return variantKey;
    return variantChoices[0]?.key ?? "";
  }, [variantChoices, variantKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/inventory", withAdminAuth());
      const data = (await res.json()) as InventoryPayload;
      if (!res.ok || !data.ok) {
        setError(data?.error ?? "No se pudo cargar el inventario.");
        return;
      }
      setItems(data.items ?? []);
      setLowStock(data.lowStock ?? []);
    } catch {
      setError("Error de red al cargar el inventario.");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Valida el token contra la API y, de paso, trae el inventario.
   * Un token inválido devuelve 401/503 y no se abre el panel.
   */
  const handleLogin = async () => {
    const candidate = token.trim();
    if (!candidate) return;
    setAuthError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/admin/inventory", withAdminAuth({}, candidate));
      const data = (await res.json().catch(() => null)) as InventoryPayload | null;

      if (!res.ok || !data?.ok) {
        setAuthError(data?.error ?? "Token de administración inválido.");
        return;
      }

      // Token válido: se recuerda en el navegador y se abre el panel.
      setAdminToken(candidate);
      setItems(data.items ?? []);
      setLowStock(data.lowStock ?? []);
      setAuthed(true);
    } catch {
      setAuthError("No hay conexión con el servidor.");
    } finally {
      setLoading(false);
    }
  };

  const handleReceipt = async () => {
    if (submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch(
        "/api/admin/inventory",
        withAdminAuth({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productSlug,
            variantKey: effectiveVariantKey,
            quantity,
            reorderPoint: reorderPoint.trim() === "" ? undefined : Number(reorderPoint),
          }),
        }),
      );
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setFeedback(data?.error ?? "No se pudo registrar el ingreso.");
        return;
      }
      setFeedback(`Ingreso registrado: ${quantity} unidad(es).`);
      await load();
    } catch {
      setFeedback("Error de red al registrar el ingreso.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-8">
        <div className="w-full max-w-sm border border-white/15 rounded-3xl p-8 bg-neutral-900">
          <h1 className="text-2xl font-semibold mb-2">Inventario</h1>
          <p className="text-sm text-white/60 mb-6">Ingresa el token de administración.</p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleLogin();
            }}
            placeholder="ADMIN_API_SECRET"
            className="w-full h-12 rounded-2xl border border-white/20 bg-neutral-950 px-4 mb-4"
          />
          {authError && <p className="text-sm text-red-400 mb-4">{authError}</p>}
          <button
            onClick={() => void handleLogin()}
            disabled={loading}
            className="w-full h-12 rounded-2xl bg-white text-black font-medium hover:bg-white/90 disabled:bg-white/50"
          >
            {loading ? "Verificando…" : "Entrar"}
          </button>
          <Link href="/admin" className="block text-center text-xs text-white/50 mt-4 hover:text-white">
            ← Volver al panel
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50">OPERACIÓN</div>
            <h1 className="text-4xl font-semibold tracking-tight">Inventario</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void load()}
              className="text-sm px-4 py-2 rounded-full border border-white/20 hover:bg-white/5"
            >
              {loading ? "Actualizando…" : "Actualizar"}
            </button>
            <Link href="/admin" className="text-sm text-white/70 hover:text-white">
              Panel →
            </Link>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">
            {error}
          </div>
        )}

        {/* Alertas de stock bajo */}
        {lowStock.length > 0 && (
          <div className="mb-8 rounded-3xl border border-amber-500/40 bg-amber-500/10 p-6">
            <div className="text-sm tracking-widest text-amber-300 mb-3">⚠ ALERTAS DE STOCK BAJO</div>
            <ul className="space-y-1 text-sm">
              {lowStock.map((item) => (
                <li key={`${item.productSlug}:${item.variantKey}`}>
                  <span className="font-medium">{item.productSlug}</span>
                  {item.variantKey && <span className="text-white/60"> ({item.variantKey})</span>}: quedan{" "}
                  <span className="font-mono">{item.quantityAvailable}</span> (reorden en {item.reorderPoint})
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Registrar ingreso de mercadería */}
        <div className="mb-10 rounded-3xl border border-white/15 bg-neutral-900 p-6">
          <div className="text-sm tracking-widest text-white/60 mb-4">REGISTRAR INGRESO DE MERCADERÍA</div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm">
              <span className="block text-white/60 mb-1">Producto</span>
              <select
                value={productSlug}
                onChange={(e) => setProductSlug(e.target.value)}
                className="w-full h-11 rounded-xl border border-white/20 bg-neutral-950 px-3"
              >
                {baseProductsData.map((product) => (
                  <option key={product.slug} value={product.slug}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="block text-white/60 mb-1">Variante</span>
              <select
                value={effectiveVariantKey}
                onChange={(e) => setVariantKey(e.target.value)}
                className="w-full h-11 rounded-xl border border-white/20 bg-neutral-950 px-3"
              >
                {variantChoices.map((choice) => (
                  <option key={choice.key || "base"} value={choice.key}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="block text-white/60 mb-1">Cantidad</span>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="w-full h-11 rounded-xl border border-white/20 bg-neutral-950 px-3"
              />
            </label>

            <label className="text-sm">
              <span className="block text-white/60 mb-1">Punto de reorden (opcional)</span>
              <input
                type="number"
                min={0}
                value={reorderPoint}
                onChange={(e) => setReorderPoint(e.target.value)}
                placeholder="ej. 5"
                className="w-full h-11 rounded-xl border border-white/20 bg-neutral-950 px-3"
              />
            </label>
          </div>

          <div className="mt-5 flex items-center gap-4">
            <button
              onClick={() => void handleReceipt()}
              disabled={submitting}
              className="h-11 px-6 rounded-2xl bg-white text-black font-medium hover:bg-white/90 disabled:bg-white/50"
            >
              {submitting ? "Registrando…" : "Registrar ingreso"}
            </button>
            {feedback && <span className="text-sm text-white/70">{feedback}</span>}
          </div>
        </div>

        {/* Inventario completo */}
        <div className="rounded-3xl border border-white/15 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-white/60">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Producto</th>
                <th className="text-left px-4 py-3 font-medium">Variante</th>
                <th className="text-right px-4 py-3 font-medium">Físico</th>
                <th className="text-right px-4 py-3 font-medium">Reservado</th>
                <th className="text-right px-4 py-3 font-medium">Disponible</th>
                <th className="text-right px-4 py-3 font-medium">Reorden</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.productSlug}:${item.variantKey}`} className="border-t border-white/10">
                  <td className="px-4 py-3">{item.productSlug}</td>
                  <td className="px-4 py-3 text-white/60">{item.variantKey || "—"}</td>
                  <td className="px-4 py-3 text-right font-mono">{item.quantityOnHand}</td>
                  <td className="px-4 py-3 text-right font-mono">{item.quantityReserved}</td>
                  <td className="px-4 py-3 text-right font-mono">{item.quantityAvailable}</td>
                  <td className="px-4 py-3 text-right font-mono">{item.reorderPoint}</td>
                </tr>
              ))}
              {items.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-white/50">
                    No hay SKUs en inventario. Registra un ingreso para empezar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
