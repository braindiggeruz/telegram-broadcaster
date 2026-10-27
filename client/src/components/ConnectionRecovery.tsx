import * as React from "react";
import {
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type ConnectionRecoveryState =
  | "checking"
  | "offline"
  | "reconnecting"
  | "unavailable";

type ConnectionRecoveryProps = {
  state: ConnectionRecoveryState;
  isFetching: boolean;
  onRetry: () => void;
};

const recoveryCopy = {
  checking: {
    title: "Проверяем доступ",
    description: "Подключаемся к сервису и проверяем вашу сессию.",
    detail: "Страница откроется автоматически после проверки.",
  },
  offline: {
    title: "Нет соединения",
    description:
      "Проверьте подключение к интернету. Мы продолжим проверку, как только связь появится.",
    detail:
      "Проверка возобновится автоматически, когда устройство снова будет в сети.",
  },
  reconnecting: {
    title: "Восстанавливаем соединение",
    description:
      "Связь с сервисом временно прервалась. Повторяем проверку доступа автоматически.",
    detail: "Когда связь восстановится, вы сможете продолжить работу.",
  },
  unavailable: {
    title: "Проверка доступа недоступна",
    description:
      "Сейчас не удалось проверить вашу сессию. Попробуйте повторить проверку через несколько секунд.",
    detail: "Если это повторится, обратитесь к администратору сервиса.",
  },
} satisfies Record<
  ConnectionRecoveryState,
  {
    title: string;
    description: string;
    detail: string;
  }
>;

export default function ConnectionRecovery({
  state,
  isFetching,
  onRetry,
}: ConnectionRecoveryProps) {
  const copy = recoveryCopy[state];
  const Icon =
    state === "offline"
      ? WifiOff
      : state === "unavailable"
        ? ShieldCheck
        : state === "checking"
          ? LoaderCircle
          : RefreshCw;

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-2.5 text-sm font-semibold tracking-tight">
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Send aria-hidden="true" className="size-4" />
          </span>
          TG Sender <span className="text-primary">2.0</span>
        </div>
        <section
          aria-labelledby="connection-recovery-title"
          className="rounded-2xl border border-border bg-card p-6 shadow-xl shadow-black/10 sm:p-8"
        >
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="space-y-5"
          >
            <div className="flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
              <Icon
                aria-hidden="true"
                className={`size-5 ${isFetching && state !== "offline" && state !== "unavailable" ? "animate-spin motion-reduce:animate-none" : ""}`}
              />
            </div>
            <div className="space-y-2">
              <h1
                id="connection-recovery-title"
                className="text-xl font-semibold tracking-tight text-foreground"
              >
                {copy.title}
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                {copy.description}
              </p>
            </div>
            <p className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
              {copy.detail}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="mt-6 h-10 w-full rounded-lg"
            disabled={isFetching}
            onClick={onRetry}
          >
            <RefreshCw
              aria-hidden="true"
              className={
                isFetching ? "animate-spin motion-reduce:animate-none" : ""
              }
            />
            Повторить сейчас
          </Button>
        </section>
      </div>
    </main>
  );
}
