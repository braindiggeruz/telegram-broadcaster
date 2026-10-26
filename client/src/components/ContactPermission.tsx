import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { ShieldMinus } from "lucide-react";
import { normalizeRecipient } from "@shared/recipients";

export default function ContactPermission() {
  const [recipient, setRecipient] = useState("");
  const [transport, setTransport] = useState<"bot" | "mtproto">("bot");
  const [source, setSource] = useState("");
  const revoke = trpc.recipients.setPermission.useMutation({
    onSuccess: () => {
      toast.success("Контакт исключён из будущих отправок, включая очередь");
      setRecipient("");
      setSource("");
    },
    onError: error => toast.error(error.message),
  });
  const normalized = normalizeRecipient(recipient);
  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldMinus className="h-4 w-4 text-primary" />
        <h2 className="font-semibold text-sm">Исключить получателя</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Отписка действует на текущую очередь и будущие кампании. Повторный
        импорт не отменяет её.
      </p>
      <form
        className="grid sm:grid-cols-2 gap-3"
        onSubmit={event => {
          event.preventDefault();
          if (normalized)
            revoke.mutate({
              transport,
              recipient: normalized.value,
              allowed: false,
              source: source.trim(),
            });
        }}
      >
        <label className="text-xs space-y-2">
          <span>Получатель</span>
          <Input
            value={recipient}
            onChange={event => setRecipient(event.target.value)}
            placeholder="Chat ID, @username или +телефон"
            required
          />
        </label>
        <label className="text-xs space-y-2">
          <span>Подключение</span>
          <select
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={transport}
            onChange={event =>
              setTransport(event.target.value as "bot" | "mtproto")
            }
          >
            <option value="bot">Бот</option>
            <option value="mtproto">Личный аккаунт</option>
          </select>
        </label>
        <label className="text-xs space-y-2">
          <span>Основание</span>
          <Input
            value={source}
            onChange={event => setSource(event.target.value)}
            placeholder="Например: просьба получателя в чате"
            required
          />
        </label>
        <Button
          type="submit"
          className="self-end"
          variant="outline"
          disabled={!normalized || source.trim().length < 3 || revoke.isPending}
        >
          Исключить из отправок
        </Button>
      </form>
    </section>
  );
}
