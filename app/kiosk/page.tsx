"use client";

import { useState } from "react";
import Link from "next/link";

type KioskStep = "welcome" | "locate" | "review" | "verify" | "complete";

export default function KioskPage() {
  const [step, setStep] = useState<KioskStep>("welcome");
  const [orderNumber, setOrderNumber] = useState("");

  const handleLocate = () => {
    if (orderNumber.trim()) {
      setStep("review");
    }
  };

  const reset = () => {
    setStep("welcome");
    setOrderNumber("");
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white font-mono">
      {/* Kiosk Header */}
      <div className="border-b border-white/10 bg-black/50">
        <div className="max-w-4xl mx-auto px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-white text-black flex items-center justify-center font-semibold">U</div>
            <div>
              <div className="text-sm tracking-[3px]">UMANTAI</div>
              <div className="text-[10px] text-white/50 -mt-1">FLAGSHIP • SOHO</div>
            </div>
          </div>
          <div className="text-xs text-white/50 tracking-widest">KIOSK ONLINE • TERMINAL #03</div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-8 pt-16 pb-20">
        {step === "welcome" && (
          <div className="text-center">
            <div className="uppercase tracking-[4px] text-xs text-white/50 mb-4">SELF-SERVICE PICKUP</div>
            <h1 className="text-6xl tracking-[-2px] font-semibold mb-4">Your order is ready.</h1>
            <p className="text-xl text-white/70 mb-12">Skip the line. Collect in under 90 seconds.</p>

            <div className="max-w-sm mx-auto">
              <button
                onClick={() => setStep("locate")}
                className="w-full h-16 rounded-2xl bg-white text-black text-lg font-medium hover:bg-white/90 transition-colors"
              >
                Start Pickup
              </button>
              <Link href="/" className="block mt-4 text-sm text-white/50 hover:text-white">
                Return to Store
              </Link>
            </div>
          </div>
        )}

        {step === "locate" && (
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50 mb-2">STEP 1 OF 4</div>
            <h2 className="text-4xl tracking-tight mb-8">Locate your order</h2>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-white/60 block mb-2">Order Number or Phone Number</label>
                <input
                  type="text"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  placeholder="UM-48291 or (212) 555-0192"
                  className="w-full bg-neutral-900 border border-white/20 text-2xl tracking-widest py-4 px-6 rounded-2xl focus:outline-none focus:border-white/40"
                />
              </div>

              <button
                onClick={handleLocate}
                disabled={!orderNumber.trim()}
                className="w-full h-14 rounded-2xl bg-white text-black font-medium disabled:opacity-40"
              >
                Find My Order
              </button>

              <button onClick={() => setStep("welcome")} className="w-full text-sm text-white/50 hover:text-white">
                ← Back
              </button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50 mb-2">STEP 2 OF 4</div>
            <h2 className="text-4xl tracking-tight mb-8">Review your items</h2>

            <div className="bg-neutral-900 border border-white/10 rounded-3xl p-8 mb-8">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <div className="text-sm text-white/60">Order #{orderNumber || "UM-48291"}</div>
                  <div className="text-2xl">iPhone 15 Pro + Oura Ring Gen3</div>
                </div>
                <div className="text-right font-mono text-xl">$1,298</div>
              </div>

              <div className="text-sm text-white/60">2 items • Ready since 2:14pm</div>
            </div>

            <div className="flex gap-4">
              <button onClick={() => setStep("locate")} className="flex-1 h-14 rounded-2xl border border-white/30">
                ← Back
              </button>
              <button onClick={() => setStep("verify")} className="flex-1 h-14 rounded-2xl bg-white text-black font-medium">
                Confirm Pickup
              </button>
            </div>
          </div>
        )}

        {step === "verify" && (
          <div>
            <div className="uppercase tracking-[3px] text-xs text-white/50 mb-2">STEP 3 OF 4</div>
            <h2 className="text-4xl tracking-tight mb-8">Verify your identity</h2>

            <div className="bg-neutral-900 border border-white/10 rounded-3xl p-8 mb-8 text-center">
              <div className="text-6xl mb-6">📸</div>
              <div className="text-lg mb-2">Please look at the camera</div>
              <div className="text-sm text-white/50">Privacy protected • Camera active for security</div>
            </div>

            <button onClick={() => setStep("complete")} className="w-full h-14 rounded-2xl bg-white text-black font-medium">
              I’m Ready
            </button>
          </div>
        )}

        {step === "complete" && (
          <div className="text-center">
            <div className="text-7xl mb-8">✓</div>
            <h2 className="text-5xl tracking-tighter mb-4">Pickup complete.</h2>
            <p className="text-xl text-white/70 mb-12">Thank you for shopping at Umantai.</p>

            <div className="max-w-xs mx-auto space-y-3">
              <Link href="/" className="block w-full h-14 rounded-2xl bg-white text-black font-medium flex items-center justify-center">
                Return to Homepage
              </Link>
              <button onClick={reset} className="w-full text-sm text-white/50 hover:text-white">
                Start another pickup
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="text-center text-[10px] text-white/40 tracking-widest pb-8">
        UMANTAI FLAGSHIP • PRIVACY PROTECTED • CAMERA ACTIVE FOR SECURITY
      </div>
    </div>
  );
}
