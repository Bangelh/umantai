"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { withAdminAuth } from "@/lib/adminAuth";
import { AdminAccessScreen } from "@/components/admin/AdminAccessScreen";
import { usePlatformAdminSession } from "@/lib/usePlatformAdminSession";

interface Note {
  id: number;
  title: string;
}

export default function AdminNotesPage() {
  const admin = usePlatformAdminSession();
  const [notes, setNotes] = useState<Note[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchNotes = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/notes", withAdminAuth());
      const data = await res.json();
      if (data.success) {
        setNotes(data.data);
      } else {
        setError(data.error || "Failed to load notes");
      }
    } catch (err) {
      setError("Failed to fetch notes");
    } finally {
      setLoading(false);
    }
  };

  // Con sesión de Platform Admin activa, carga las notas una vez.
  useEffect(() => {
    if (admin.status === 'authenticated') void fetchNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- carga única al autenticar
  }, [admin.status]);

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/notes", withAdminAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      }));
      const data = await res.json();

      if (data.success) {
        setNotes((prev) => [...prev, data.data]);
        setNewTitle("");
      } else {
        setError(data.error || "Failed to add note");
      }
    } catch (err) {
      setError("Failed to add note");
    } finally {
      setLoading(false);
    }
  };

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen title="Notes" status={admin.status} onActivate={admin.activate} />
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="border-b border-white/10 bg-neutral-950/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-semibold text-2xl tracking-[-1px]">umantai</Link>
            <div className="text-sm px-3 py-1 rounded-full bg-white/10 text-white/80">Admin • Notes</div>
          </div>
          <Link href="/admin" className="text-sm text-white/70 hover:text-white">← Back to Admin</Link>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-8 py-10">
        <h1 className="text-4xl tracking-tighter font-semibold mb-2">Notes</h1>
        <p className="text-white/60 mb-8">Simple Supabase-backed notes demo</p>

        {/* Add new note form */}
        <form onSubmit={addNote} className="flex gap-3 mb-8">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Write a new note..."
            className="flex-1 bg-neutral-900 border border-white/20 rounded-2xl px-5 py-3 focus:outline-none focus:border-white/40"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !newTitle.trim()}
            className="px-6 py-3 bg-white text-black rounded-2xl font-medium disabled:bg-white/60 hover:bg-white/90 transition-colors"
          >
            Add Note
          </button>
        </form>

        {error && (
          <div className="mb-6 rounded-2xl bg-red-950 border border-red-900 px-5 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && notes.length === 0 ? (
          <div className="text-white/60">Loading notes...</div>
        ) : notes.length === 0 ? (
          <div className="text-white/60 italic">No notes yet. Add one above!</div>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="border border-white/10 bg-neutral-900 rounded-2xl px-6 py-4"
              >
                {note.title}
              </div>
            ))}
          </div>
        )}

        <div className="mt-10 text-xs text-white/50">
          Data is stored in Supabase. The table was created with the SQL you provided.
        </div>
      </div>
    </div>
  );
}
