import { NextRequest } from "next/server";

export function getSessionIdFromRequest(req: NextRequest): string {
  return req.headers.get("x-session-id") || "";
}
