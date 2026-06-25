// Standalone mode — no authentication required.
// This hook always returns an authenticated state so the app works
// as a personal tool without any OAuth/login flow.

export function useAuth(_options?: { redirectOnUnauthenticated?: boolean; redirectPath?: string }) {
  return {
    user: { id: 1, name: "Admin", role: "admin" as const },
    loading: false,
    error: null,
    isAuthenticated: true,
    refresh: () => Promise.resolve(),
    logout: () => Promise.resolve(),
  };
}
