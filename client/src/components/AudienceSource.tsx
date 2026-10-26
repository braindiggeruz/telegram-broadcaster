import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Link2, Copy, Loader2 } from "lucide-react";

export default function AudienceSource({
  listId,
  listName,
}: {
  listId: number;
  listName: string;
}) {
  const sources = trpc.source.list.useQuery();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"bot" | "mtproto">("bot");
  const [approved, setApproved] = useState(false);
  const [connection, setConnection] = useState<{
    secret: string;
    path: string;
  } | null>(null);
  const request = useRef<{ key: string; fingerprint: string } | null>(null);
  const cacheKey = `tg-sender:source-create:${listId}`;
  const create = trpc.source.create.useMutation({
    onSuccess: data => {
      setConnection({ secret: data.webhookSecret, path: data.webhookPath });
      request.current = null;
      try {
        localStorage.removeItem(cacheKey);
      } catch {}
      setApproved(false);
      void sources.refetch();
      toast.success("Источник подключён. Сохраните его параметры в CRM.");
    },
    onError: error => toast.error(error.message),
  });
  const revoke = trpc.source.revoke.useMutation({
    onSuccess: () => {
      void sources.refetch();
      setConnection(null);
      toast.success("Подключение отозвано");
    },
    onError: error => toast.error(error.message),
  });
  function connect() {
    const payload = {
      listId,
      transport,
      name: name.trim(),
      approved: true as const,
    };
    const fingerprint = JSON.stringify(payload);
    let previous = request.current;
    try {
      if (!previous)
        previous = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
    } catch {}
    if (!previous || previous.fingerprint !== fingerprint)
      previous = { fingerprint, key: crypto.randomUUID() };
    request.current = previous;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(previous));
    } catch {}
    create.mutate({ ...payload, requestKey: previous.key });
  }
  const linked = sources.data?.filter(source => source.listId === listId) ?? [];
  return (
    <details className="mt-4 border-t border-border pt-3">
      <summary className="text-xs text-primary cursor-pointer">
        <Link2 className="h-3 w-3 inline mr-2" />
        Подключить CRM / источник аудитории
      </summary>
      <div className="space-y-4 pt-4">
        <p className="text-xs text-muted-foreground">
          Источник обновляет список «{listName}» по защищённому webhook. Повтор
          события не дублирует импорт. Отписки сохраняются.
        </p>
        {sources.error && (
          <p className="text-xs text-red-400">{sources.error.message}</p>
        )}
        {linked.map(source => (
          <div
            key={source.id}
            className="rounded-lg bg-muted/30 p-3 flex flex-wrap items-center gap-3"
          >
            <div className="flex-1 min-w-36">
              <p className="text-xs font-medium">
                {source.name} · {source.transport === "bot" ? "Бот" : "Аккаунт"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {source.active
                  ? source.lastSyncedAt
                    ? `Обновлён ${new Date(source.lastSyncedAt).toLocaleString("ru-RU")}`
                    : "Ожидает первое событие"
                  : "Подключение отозвано"}
              </p>
            </div>
            {source.active && (
              <Button
                size="sm"
                variant="outline"
                disabled={revoke.isPending}
                onClick={() => {
                  if (
                    confirm(
                      `Отозвать доступ источника «${source.name}»? Автоматические обновления из него прекратятся.`
                    )
                  )
                    revoke.mutate({ id: source.id });
                }}
              >
                Отозвать
              </Button>
            )}
          </div>
        ))}
        {connection && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
            <p className="text-xs font-semibold">
              Параметры подключения — сохраните сейчас
            </p>
            <p className="text-xs break-all">
              <strong>POST</strong> {window.location.origin}
              {connection.path}
            </p>
            <p className="text-xs text-muted-foreground">
              Заголовок: Authorization: Bearer [секрет]
            </p>
            <input
              aria-label="Секрет источника"
              readOnly
              type="password"
              value={connection.secret}
              className="w-full rounded border border-border bg-background px-3 py-2 text-xs font-mono"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(connection.secret);
                    toast.success("Секрет скопирован");
                  } catch {
                    toast.error("Не удалось скопировать");
                  }
                }}
              >
                <Copy className="h-3 w-3" />
                Скопировать секрет
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConnection(null)}
              >
                Скрыть
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Передавайте уникальный eventId и изменения recipients. subscribed:
              true требует дату consentAt из вашей системы; subscribed: false
              исключает контакт. Повторная подписка источника не отменяет уже
              записанную отписку.
            </p>
            <pre className="text-[11px] bg-background/70 p-3 rounded overflow-x-auto">
              {JSON.stringify(
                {
                  eventId: "crm-sync-001",
                  recipients: [
                    {
                      value: "123456789",
                      subscribed: true,
                      consentAt: "2026-10-25T10:00:00Z",
                    },
                    { value: "987654321", subscribed: false },
                  ],
                },
                null,
                2
              )}
            </pre>
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-xs space-y-2">
            <span>Название источника</span>
            <Input
              value={name}
              onChange={event => {
                setName(event.target.value);
                setApproved(false);
              }}
              placeholder="Например: подписчики из CRM"
            />
          </label>
          <label className="text-xs space-y-2">
            <span>Разрешённый отправитель</span>
            <select
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              value={transport}
              onChange={event => {
                setTransport(event.target.value as "bot" | "mtproto");
                setApproved(false);
              }}
            >
              <option value="bot">Подключённый бот</option>
              <option value="mtproto">Личный аккаунт</option>
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-xs">
          <input
            className="mt-0.5"
            type="checkbox"
            checked={approved}
            onChange={event => setApproved(event.target.checked)}
          />
          <span>
            Разрешаю этому источнику добавлять подписавшихся получателей для
            выбранного отправителя и обрабатывать отписки. Источник передаёт
            подтверждённую дату согласия.
          </span>
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!name.trim() || !approved || create.isPending}
          onClick={connect}
        >
          {create.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Link2 className="h-3 w-3" />
          )}
          Подключить источник
        </Button>
      </div>
    </details>
  );
}
