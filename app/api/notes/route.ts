import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

// GET all notes
export async function GET() {
  if (!supabaseServer) {
    return NextResponse.json(
      { 
        success: false, 
        error: 'Supabase is not configured. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' 
      },
      { status: 503 }
    );
  }

  try {
    const { data, error } = await supabaseServer
      .from('notes')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// POST - Create a new note
export async function POST(request: NextRequest) {
  if (!supabaseServer) {
    return NextResponse.json(
      { 
        success: false, 
        error: 'Supabase is not configured.' 
      },
      { status: 503 }
    );
  }

  try {
    const body = await request.json();
    const { title } = body;

    if (!title) {
      return NextResponse.json(
        { success: false, error: 'Title is required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseServer
      .from('notes')
      .insert({ title })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
