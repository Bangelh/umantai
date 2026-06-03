export function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";

  let sessionId = localStorage.getItem("umantai-session-id");
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("umantai-session-id", sessionId);
  }
  return sessionId;
}

export function getSessionHeaders() {
  const sessionId = getOrCreateSessionId();
  return {
    "x-session-id": sessionId,
  };
}
