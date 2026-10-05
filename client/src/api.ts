import { feedback } from "./feedback";

const TOKEN_KEY = "realworld_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 신고 누적으로 이용 정지된 계정이면 App이 정지 화면으로 바꾼다. */
export const BANNED_EVENT = "account:banned";

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // 서버가 토큰을 연장해 주면(발급 하루 경과 후) 새 토큰으로 바꿔 둔다 — 자주 들어오면 만료되지 않는다.
  const refreshed = res.headers.get("X-Refresh-Token");
  if (refreshed && token) setToken(refreshed);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (method !== "GET") feedback("error"); // 누른 동작이 실패하면 짧은 경고음(조회 실패는 조용히)
    if (data?.code === "banned") window.dispatchEvent(new CustomEvent(BANNED_EVENT, { detail: { isGuest: !!data.isGuest } }));
    throw new ApiError(res.status, data?.error ?? `요청 실패 (${res.status})`, data?.code);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

export { ApiError };
