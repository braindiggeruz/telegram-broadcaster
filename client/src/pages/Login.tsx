import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Send, LockKeyhole } from "lucide-react";
export default function Login() {
  const utils = trpc.useUtils();
  const [password, setPassword] = useState("");
  const login = trpc.auth.login.useMutation({
    onSuccess: async () => {
      setPassword("");
      await utils.auth.me.invalidate();
    },
  });
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm space-y-7">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-primary p-3">
            <Send className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">
              TG Sender <span className="text-primary">2.0</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              Рассылки под контролем
            </p>
          </div>
        </div>
        <form
          className="rounded-2xl border border-border bg-card p-6 space-y-5"
          onSubmit={e => {
            e.preventDefault();
            login.mutate({ password });
          }}
        >
          <div>
            <h2 className="font-semibold">Вход владельца</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Введите пароль доступа к вашему сервису.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="owner-password" className="text-sm">
              Пароль
            </label>
            <Input
              id="owner-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>
          {login.error && (
            <p role="alert" className="text-sm text-red-400">
              {login.error.message}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={!password || login.isPending}
          >
            {login.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LockKeyhole className="h-4 w-4" />
            )}
            Войти
          </Button>
        </form>
        <p className="text-xs text-muted-foreground text-center">
          Доступ к получателям, кампаниям и подключениям защищён входом.
        </p>
      </div>
    </main>
  );
}
