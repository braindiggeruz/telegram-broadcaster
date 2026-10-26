import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function ResolveUnknown({
  transport,
  id,
  rows,
  onResolved,
}: {
  transport: "bot" | "mtproto";
  id: number;
  rows: { id: string; recipient: string; status: string }[];
  onResolved: () => void;
}) {
  const unknowns = rows.filter(row => row.status === "unknown");
  const key = unknowns.map(row => row.id).join(",");
  const [selected, setSelected] = useState<string[]>([]);
  const [evidence, setEvidence] = useState("");
  const [resolution, setResolution] = useState<"accepted" | "cancelled">(
    "cancelled"
  );
  const [confirmed, setConfirmed] = useState(false);
  const bot = trpc.broadcast.resolveUnknown.useMutation();
  const account = trpc.mtproto.resolveUnknown.useMutation();
  useEffect(() => {
    setSelected([]);
    setConfirmed(false);
  }, [key]);
  if (!unknowns.length) return null;
  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-4">
      <h2 className="font-semibold text-sm">
        Разобрать неизвестные результаты
      </h2>
      <p className="text-xs text-muted-foreground">
        На этой странице {unknowns.length} отправок без подтверждённого
        результата. Выберите проверенные строки. Повторная отправка из этого
        окна не выполняется.
      </p>
      <div className="flex flex-wrap gap-3">
        {unknowns.map(row => (
          <label
            key={row.id}
            className="flex gap-2 items-center text-xs font-mono"
          >
            <input
              type="checkbox"
              checked={selected.includes(row.id)}
              onChange={event => {
                setSelected(
                  event.target.checked
                    ? [...selected, row.id]
                    : selected.filter(value => value !== row.id)
                );
                setConfirmed(false);
              }}
            />
            {row.recipient}
          </label>
        ))}
      </div>
      <label className="block text-sm space-y-2">
        <span>Решение для выбранных строк</span>
        <select
          className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          value={resolution}
          onChange={event => {
            setResolution(event.target.value as "accepted" | "cancelled");
            setConfirmed(false);
          }}
        >
          <option value="cancelled">Закрыть без повтора</option>
          <option value="accepted">
            Принято Telegram — есть подтверждение
          </option>
        </select>
      </label>
      <label className="block text-sm space-y-2">
        <span>Основание решения</span>
        <textarea
          className="w-full rounded-lg border border-border bg-background p-3 text-sm min-h-20"
          value={evidence}
          onChange={event => {
            setEvidence(event.target.value);
            setConfirmed(false);
          }}
          placeholder={
            resolution === "accepted"
              ? "Где проверено сообщение, дата и подтверждение отправки"
              : "Почему принято решение завершить без повторной отправки"
          }
        />
      </label>
      {resolution === "accepted" && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={event => setConfirmed(event.target.checked)}
          />
          Подтверждаю успешную отправку каждой выбранной строки по указанным
          доказательствам.
        </label>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={
          !selected.length ||
          evidence.trim().length < 10 ||
          (resolution === "accepted" && !confirmed) ||
          bot.isPending ||
          account.isPending
        }
        onClick={async () => {
          try {
            await (transport === "bot" ? bot : account).mutateAsync({
              id,
              deliveryIds: selected,
              resolution,
              evidence: evidence.trim(),
            });
            toast.success(
              "Решение сохранено. Повторная отправка не запускалась."
            );
            setSelected([]);
            setEvidence("");
            setConfirmed(false);
            onResolved();
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : "Не удалось сохранить решение"
            );
          }
        }}
      >
        {resolution === "cancelled"
          ? "Закрыть без повтора"
          : "Подтвердить принятое Telegram"}{" "}
        ({selected.length})
      </Button>
    </section>
  );
}
