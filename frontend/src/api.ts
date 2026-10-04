import { errorBody, membership, type Membership } from "./protocol";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function request(
  path: string,
  init: RequestInit,
  token?: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...init.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new ApiError(
      "network",
      "Cannot reach the call server. Check your connection.",
    );
  }
  if (!response.ok) {
    const parsed = errorBody.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      parsed.success ? parsed.data.error.code : "server_error",
      parsed.success
        ? parsed.data.error.message
        : "The server could not complete that request.",
    );
  }
  return response;
}

export async function enter(
  mode: "demo" | "live",
  sessionId?: string,
): Promise<Membership> {
  const path = sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}/join`
    : "/sessions";
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionId ? {} : { mode }),
  });
  return membership.parse(await response.json());
}
