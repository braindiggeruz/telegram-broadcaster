import { Link } from "wouter";
import { Check, Loader2, MessageSquare, ArrowRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useServerDraft, type ParseMode } from "@/hooks/useServerDraft";
import MessagePreview from "@/components/MessagePreview";

export default function Composer() {
  const draft = useServerDraft("bot");
  return (
    <div className="p-5 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Сообщение</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Черновик сохраняется автоматически. Возвращайтесь к нему в любой
            момент.
          </p>
        </div>
        <span
          className="flex items-center gap-2 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {draft.saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {!draft.ready
            ? "Загрузка…"
            : draft.error
              ? "Требуется внимание"
              : draft.dirty
                ? "Сохраняем…"
                : `Сохранено · версия ${draft.version}`}
        </span>
      </div>
      {draft.error && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3"
        >
          <p className="text-sm">{draft.error}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={draft.conflicted}
              onClick={draft.retry}
            >
              Повторить сохранение
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (confirm("Заменить локальный текст версией с сервера?"))
                  void draft.reloadServer();
              }}
            >
              Загрузить с сервера
            </Button>
          </div>
        </div>
      )}
      <div className="grid lg:grid-cols-2 gap-5">
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-border">
            <label
              htmlFor="message"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <MessageSquare className="h-4 w-4 text-primary" />
              Текст сообщения
            </label>
            <select
              aria-label="Формат сообщения"
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
              disabled={!draft.ready}
              value={draft.parseMode}
              onChange={e => draft.setParseMode(e.target.value as ParseMode)}
            >
              <option value="HTML">HTML</option>
              <option value="Markdown">Markdown</option>
              <option value="None">Обычный текст</option>
            </select>
          </div>
          <textarea
            id="message"
            className="w-full min-h-80 bg-transparent p-4 text-sm font-mono resize-y focus:outline-none"
            disabled={!draft.ready}
            placeholder="Напишите сообщение для вашей аудитории…"
            value={draft.message}
            onChange={e => draft.setMessage(e.target.value)}
          />
          <div className="border-t border-border p-4 flex items-center justify-between gap-3">
            <span
              className={`text-xs ${draft.message.length > 4096 ? "text-red-400" : "text-muted-foreground"}`}
            >
              {draft.message.length} / 4096 символов исходного текста
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(draft.message);
                  toast.success("Текст скопирован");
                } catch {
                  toast.error("Не удалось скопировать текст");
                }
              }}
            >
              <Copy className="h-4 w-4" />
              Копировать
            </Button>
          </div>
        </section>
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="font-medium text-sm">Как выглядит сообщение</h2>
          <MessagePreview message={draft.message} parseMode={draft.parseMode} />
          <div className="text-xs text-muted-foreground space-y-2 pt-4">
            <p>
              HTML: <code>&lt;b&gt;жирный&lt;/b&gt;</code>,{" "}
              <code>&lt;i&gt;курсив&lt;/i&gt;</code>,{" "}
              <code>&lt;a href="https://…"&gt;ссылка&lt;/a&gt;</code>.
            </p>
            <p>
              Markdown: <code>*жирный*</code>, <code>_курсив_</code>,{" "}
              <code>[ссылка](https://…)</code>.
            </p>
          </div>
        </section>
      </div>
      <div className="flex justify-end">
        <Link href="/launch">
          <Button
            disabled={
              !draft.ready ||
              !!draft.error ||
              !draft.message.trim() ||
              draft.saving ||
              draft.dirty
            }
          >
            К настройке рассылки
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
