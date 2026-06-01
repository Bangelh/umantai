"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Note {
  id: number;
  title: string;
}

export default function AdminNotesPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    // Same simple password as main admin for now
    if (password === "umantai" || password === "admin") {
      setIsAuthenticated(true);
      fetchNotes();
    } else {
      alert("Wrong password. Try 'umantai'");
    }
  };

  const fetchNotes = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/notes");
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

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
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

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <div className="max-w-md w-full px-8">
          <div className="text-center mb-8">
            <div className="text-4xl font-semibold tracking-tighter mb-2">umantai</div>
            <div className="text-white/60">Admin • Notes</div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin password"
              className="w-full bg-neutral-900 border border-white/20 rounded-xl px-4 py-3 text-lg focus:outline-none focus:border-white/40"
              autoFocus
            />
            <button
              type="submit"
              className="w-full py-3 bg-white text-black rounded-xl font-medium hover:bg-white/90 transition-colors"
            >
              Enter Notes Admin
            </button>
          </form>

          <p className="text-center text-white/40 text-sm mt-6">
            Password: <span className="font-mono">umantai</span>
          </p>

          <div className="mt-8 text-center">
            <Link href="/admin" className="text-sm text-white/50 hover:text-white">
              ← Back to Admin
            </Link>
          </div>
        </div>
      </div>
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
