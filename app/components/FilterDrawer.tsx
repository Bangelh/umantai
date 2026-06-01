"use client";

interface FilterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  // You can pass filter state and handlers as props for full control
  children: React.ReactNode;
}

export function FilterDrawer({ isOpen, onClose, children }: FilterDrawerProps) {
  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/70 z-[60] lg:hidden" 
        onClick={onClose} 
      />

      {/* Slide-in Drawer from Right */}
      <div className="fixed top-0 right-0 bottom-0 w-[82%] max-w-[340px] bg-neutral-950 z-[70] lg:hidden flex flex-col transform transition-transform duration-300 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-white/10 bg-neutral-900">
          <span className="font-semibold text-lg">Filters</span>
          <button 
            onClick={onClose} 
            className="text-3xl leading-none text-white/70 active:text-white"
          >
            ×
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-5 py-6">
          {children}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/10 bg-neutral-900">
          <button
            onClick={onClose}
            className="w-full py-3.5 bg-white text-black rounded-2xl font-medium active:bg-white/90"
          >
            Apply Filters
          </button>
        </div>
      </div>
    </>
  );
}
