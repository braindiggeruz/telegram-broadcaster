import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Bot, CheckCircle2, Loader2, Shield, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
export default function BotToken() {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const settings = trpc.bot.get.useQuery();
  const webhook = trpc.bot.configureWebhook.useMutation({
    onSuccess: () =>
      toast.success(
        "Telegram подтвердил подключение команд подписки и отписки"
      ),
    onError: error => toast.error(error.message),
  });
  const validate = trpc.bot.validate.useMutation({
    onSuccess: data => {
      if (data.valid) {
        setToken("");
        setShow(false);
        toast.success("Бот подключён");
        void settings.refetch();
      } else toast.error(data.error ?? "Не удалось проверить токен");
    },
    onError: error => toast.error(error.message),
  });
  return (
    <div className="p-5 lg:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Telegram-бот</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Подключите один раз. Сервис сохранит токен на сервере.
        </p>
      </div>
      {settings.error && (
        <p role="alert" className="text-sm text-red-400">
          {settings.error.message}
        </p>
      )}
      <section className="rounded-xl border border-border bg-card p-5 flex items-center gap-4">
        <div className="rounded-xl bg-primary/10 p-3">
          <Bot className="h-6 w-6 text-primary" />
        </div>
        <div className="flex-1">
          {settings.isLoading ? (
            <p className="text-sm text-muted-foreground">
              Проверяем подключение…
            </p>
          ) : settings.data?.isValid ? (
            <>
              <p className="font-semibold text-sm flex items-center gap-2">
                {settings.data.botName}
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                @{settings.data.botUsername}
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-sm">Бот пока не подключён</p>
              <p className="text-xs text-muted-foreground mt-1">
                Введите новый токен ниже.
              </p>
            </>
          )}
        </div>
      </section>
      {settings.data?.configured && (
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Токен сохранён. Сохранённый секрет не передаётся в браузер.
        </p>
      )}
      <form
        className="rounded-xl border border-border bg-card p-5 space-y-4"
        onSubmit={event => {
          event.preventDefault();
          validate.mutate({ token: token.trim() });
        }}
      >
        <label htmlFor="bot-token" className="text-sm font-medium">
          {settings.data?.configured ? "Заменить токен" : "Токен из BotFather"}
        </label>
        <div className="relative">
          <Input
            id="bot-token"
            autoComplete="off"
            type={show ? "text" : "password"}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Вставьте токен вашего бота"
            className="pr-12 font-mono"
          />
          <button
            type="button"
            aria-label={
              show ? "Скрыть введённый токен" : "Показать введённый токен"
            }
            className="absolute right-3 top-2.5 text-muted-foreground"
            onClick={() => setShow(!show)}
          >
            {show ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        <Button
          type="submit"
          disabled={!token.trim() || validate.isPending}
          className="w-full"
        >
          {validate.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Проверить и сохранить
        </Button>
      </form>
      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold">
          Подписка и отписка без ручной работы
        </h2>
        <p className="text-xs text-muted-foreground">
          Команда <code>/subscribe</code> подтверждает подписку на сообщения
          этого бота. <code>/stop</code> и <code>/unsubscribe</code> исключают
          человека из очереди и следующих кампаний. Одна команда{" "}
          <code>/start</code> не считается согласием на рассылки.
        </p>
        {window.location.protocol !== "https:" && (
          <p className="text-xs text-amber-400">
            Подключение команд доступно после размещения сервиса на публичном
            HTTPS-адресе. На локальном стенде можно проверить остальные функции.
          </p>
        )}
        <Button
          className="max-w-full whitespace-normal h-auto min-h-9"
          variant="outline"
          disabled={
            !settings.data?.isValid ||
            webhook.isPending ||
            window.location.protocol !== "https:"
          }
          onClick={() => webhook.mutate()}
        >
          {webhook.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Включить подписку /subscribe и отписку /stop
        </Button>
        {webhook.data?.configured && (
          <p role="status" className="text-xs text-emerald-400">
            Telegram подтвердил настройку при последнем запросе.
          </p>
        )}
        {webhook.error && (
          <p role="alert" className="text-xs text-red-400">
            {webhook.error.message}
          </p>
        )}
      </section>
      <section className="text-sm text-muted-foreground space-y-3">
        <p>
          Создайте бота через{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary"
          >
            @BotFather
          </a>{" "}
          командой <code>/newbot</code>, затем вставьте выданный токен.
        </p>
        <p>
          Для личных сообщений получатель должен сначала написать боту. Импорт
          телефона не позволяет боту первым начать диалог.
        </p>
      </section>
      {settings.data?.isValid && (
        <Link href="/recipients">
          <Button variant="outline">Перейти к аудитории</Button>
        </Link>
      )}
    </div>
  );
}
