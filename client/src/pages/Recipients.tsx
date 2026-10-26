import { useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Upload,
  Users,
  Trash2,
  Loader2,
  FileSpreadsheet,
  Check,
  Eye,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseRecipientCsv,
  previewRecipients,
  type RecipientType,
} from "@shared/recipients";
import ContactPermission from "@/components/ContactPermission";
import AudienceSource from "@/components/AudienceSource";
import { inspectXlsxZip } from "@shared/xlsxSafety";

type Sheet = { name: string; rows: unknown[][] };
type Mapping = {
  sheet: number;
  column: number;
  type: RecipientType;
  skipHeader: boolean;
};
const headerPattern =
  /^(phone|телефон|номер|chat.?id|telegram.?id|username|user.?name|получатель|recipient)$/i;
const emptyMapping: Mapping = {
  sheet: 0,
  column: 0,
  type: "auto",
  skipHeader: false,
};
const selectClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

function jsonSheets(content: string): Sheet[] {
  const data = JSON.parse(content);
  const values = Array.isArray(data)
    ? data
    : (data.users ?? data.chat_ids ?? data.phones);
  if (!Array.isArray(values))
    throw new Error("JSON должен содержать массив получателей");
  if (values.length > 20000)
    throw new Error("Максимум 20 000 строк за один импорт");
  if (values.some(value => value !== null && typeof value === "object"))
    throw new Error("Для JSON используйте массив строк или чисел");
  return [{ name: "Получатели", rows: values.map(value => [value]) }];
}

export default function Recipients() {
  const [fileName, setFileName] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping);
  const [mappingKey, setMappingKey] = useState("");
  const [source, setSource] = useState("");
  const [permissionTransport, setPermissionTransport] = useState<
    "bot" | "mtproto"
  >("bot");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lists = trpc.recipients.list.useQuery();
  const upload = trpc.recipients.upload.useMutation({
    onSuccess: () => {
      toast.success("Список сохранён");
      try {
        localStorage.setItem(mappingKey, JSON.stringify(mapping));
      } catch {}
      setSheets([]);
      setFileName("");
      setConsent(false);
      void lists.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const remove = trpc.recipients.delete.useMutation({
    onSuccess: () => {
      toast.success("Список удалён");
      void lists.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const rows = sheets[mapping.sheet]?.rows ?? [];
  const result = useMemo(
    () =>
      previewRecipients(rows, mapping.column, mapping.type, mapping.skipHeader),
    [rows, mapping.column, mapping.type, mapping.skipHeader]
  );
  const columns = Math.min(
    50,
    rows.reduce((max, row) => Math.max(max, row.length), 0)
  );

  async function readFile(file: File) {
    setBusy(true);
    setSheets([]);
    setConsent(false);
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error(
          "Файл больше 5 МБ. Разделите его на несколько списков."
        );
      const ext = file.name.split(".").pop()?.toLowerCase();
      let parsed: Sheet[];
      if (ext === "xlsx") {
        const data = await file.arrayBuffer();
        inspectXlsxZip(data);
        const excel = await import("exceljs");
        const workbook = new excel.Workbook();
        await workbook.xlsx.load(data as never);
        if (workbook.worksheets.length > 20)
          throw new Error(
            "В файле больше 20 листов. Оставьте лист с получателями."
          );
        parsed = workbook.worksheets.map(sheet => {
          if (sheet.rowCount > 20001 || sheet.columnCount > 50)
            throw new Error(
              "На листе максимум 20 000 получателей и 50 колонок"
            );
          const rows: unknown[][] = [];
          sheet.eachRow({ includeEmpty: true }, row => {
            const cells: unknown[] = [];
            for (let index = 1; index <= sheet.columnCount; index++) {
              const cell = row.getCell(index);
              const value = cell.value;
              cells.push(
                value && typeof value === "object"
                  ? "richText" in value
                    ? value.richText.map(part => part.text).join("")
                    : "[формула или сложное значение]"
                  : (value ?? "")
              );
            }
            rows.push(cells);
          });
          return { name: sheet.name, rows };
        });
      } else if (ext === "csv" || ext === "txt")
        parsed = [
          { name: "Получатели", rows: parseRecipientCsv(await file.text()) },
        ];
      else if (ext === "json") parsed = jsonSheets(await file.text());
      else
        throw new Error(
          "Выберите XLSX, CSV или JSON. Старый XLS сохраните как XLSX."
        );
      if (!parsed.length) throw new Error("В файле нет листов");
      const header = parsed[0].rows[0] ?? [];
      const column = Math.max(
        0,
        header.findIndex(value => headerPattern.test(String(value).trim()))
      );
      const label = String(header[column] ?? "").toLowerCase();
      let suggested: Mapping = {
        sheet: 0,
        column,
        skipHeader: headerPattern.test(label),
        type: /phone|телефон|номер/.test(label)
          ? "phone"
          : /username|user.?name/.test(label)
            ? "username"
            : /id/.test(label)
              ? "chat_id"
              : "auto",
      };
      const cacheKey = `tg-sender:import:${file.name}:${header.map(String).join("|").slice(0, 200)}`;
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
        if (
          cached &&
          parsed[cached.sheet] &&
          Number.isInteger(cached.column) &&
          cached.column >= 0 &&
          cached.column < 50 &&
          ["auto", "chat_id", "phone", "username"].includes(cached.type) &&
          typeof cached.skipHeader === "boolean"
        )
          suggested = cached;
      } catch {}
      setSheets(parsed);
      setFileName(file.name);
      setMapping(suggested);
      setMappingKey(cacheKey);
      setSource("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Не удалось прочитать файл"
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="p-5 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Аудитория</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Выберите колонку один раз. Следующий файл того же формата распознается
          по сохранённым настройкам.
        </p>
      </div>
      <section className="rounded-xl border border-border bg-card p-5 space-y-5">
        {!sheets.length ? (
          <button
            disabled={busy}
            className="w-full rounded-xl border-2 border-dashed border-border hover:border-primary/50 p-10 text-center transition-colors"
            onClick={() => input.current?.click()}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault();
              if (!busy && event.dataTransfer.files[0])
                void readFile(event.dataTransfer.files[0]);
            }}
          >
            {busy ? (
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary mb-3" />
            ) : (
              <Upload className="h-8 w-8 mx-auto text-primary mb-3" />
            )}
            <span className="block font-medium">
              {busy ? "Читаем файл…" : "Перетащите файл или выберите его"}
            </span>
            <span className="block text-sm text-muted-foreground mt-2">
              XLSX, CSV, JSON · до 5 МБ · до 20 000 получателей
            </span>
          </button>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <FileSpreadsheet className="h-6 w-6 text-primary" />
              <div className="flex-1 min-w-0">
                <h2 className="font-medium truncate">{fileName}</h2>
                <p className="text-xs text-muted-foreground">
                  Импортируется только выбранная колонка выбранного листа.
                </p>
              </div>
              <Button
                aria-label="Закрыть импорт"
                variant="ghost"
                size="icon"
                onClick={() => setSheets([])}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <label className="text-xs text-muted-foreground space-y-2">
                <span>Лист</span>
                <select
                  className={selectClass}
                  value={mapping.sheet}
                  onChange={e =>
                    setMapping({
                      ...mapping,
                      sheet: Number(e.target.value),
                      column: 0,
                    })
                  }
                >
                  {sheets.map((sheet, index) => (
                    <option key={index} value={index}>
                      {sheet.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground space-y-2">
                <span>Колонка получателей</span>
                <select
                  className={selectClass}
                  value={mapping.column}
                  onChange={e =>
                    setMapping({ ...mapping, column: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: columns }, (_, index) => (
                    <option key={index} value={index}>
                      {index + 1}:{" "}
                      {String(rows[0]?.[index] ?? "").slice(0, 40) ||
                        "Без заголовка"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground space-y-2">
                <span>Тип данных</span>
                <select
                  className={selectClass}
                  value={mapping.type}
                  onChange={e =>
                    setMapping({
                      ...mapping,
                      type: e.target.value as RecipientType,
                    })
                  }
                >
                  <option value="auto">По явному формату</option>
                  <option value="chat_id">Telegram chat ID</option>
                  <option value="username">Имя пользователя</option>
                  <option value="phone">Телефон с кодом страны</option>
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mapping.skipHeader}
                onChange={e =>
                  setMapping({ ...mapping, skipHeader: e.target.checked })
                }
              />
              Первая строка — заголовок
            </label>
            <p className="text-xs text-muted-foreground">
              В режиме «По явному формату»: @имя — username, +номер — телефон,
              целое число — chat ID. Минус в ID сохраняется. Цифры из
              произвольного текста не извлекаются.
            </p>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "К сохранению", value: result.valid.length },
                { label: "Повторов", value: result.duplicates },
                { label: "Ошибочных строк", value: result.invalid.length },
              ].map(item => (
                <div key={item.label} className="rounded-xl bg-muted/40 p-3">
                  <p className="text-xl font-semibold">{item.value}</p>
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="px-3 py-2 text-xs font-medium bg-muted/30">
                Предпросмотр первых 10 получателей
              </div>
              <div className="p-3 flex flex-wrap gap-2">
                {result.valid.slice(0, 10).map(item => (
                  <code
                    key={item.value}
                    className="rounded bg-muted px-2 py-1 text-xs"
                  >
                    {item.value}{" "}
                    <span className="text-muted-foreground">({item.type})</span>
                  </code>
                ))}
                {!result.valid.length && (
                  <p className="text-sm text-muted-foreground">
                    Проверьте лист, колонку и тип данных.
                  </p>
                )}
              </div>
            </div>
            {result.invalid.length > 0 && (
              <details className="rounded-xl border border-amber-500/30 p-4 text-sm">
                <summary className="cursor-pointer text-amber-400">
                  {result.invalid.length} строк будут исключены — показать
                </summary>
                <ul className="mt-3 space-y-2">
                  {result.invalid.slice(0, 30).map(item => (
                    <li key={item.row} className="break-all">
                      Строка {item.row}: <code>{item.value}</code>
                    </li>
                  ))}
                </ul>
                {result.invalid.length > 30 && (
                  <p className="mt-2 text-xs">Показаны первые 30 ошибок.</p>
                )}
              </details>
            )}
            <div className="border-t border-border pt-4 space-y-3">
              <label className="block text-sm space-y-2">
                <span>Кому разрешены сообщения</span>
                <select
                  className={selectClass}
                  value={permissionTransport}
                  onChange={e => {
                    setPermissionTransport(e.target.value as "bot" | "mtproto");
                    setConsent(false);
                  }}
                >
                  <option value="bot">Подключённому Telegram-боту</option>
                  <option value="mtproto">
                    Подключённому личному аккаунту
                  </option>
                </select>
              </label>
              <label htmlFor="consent-source" className="text-sm font-medium">
                Источник разрешения на сообщения
              </label>
              <Input
                id="consent-source"
                placeholder="Например: подписка через бота, форма согласия в CRM"
                value={source}
                onChange={e => setSource(e.target.value)}
              />
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={consent}
                  onChange={e => setConsent(e.target.checked)}
                />
                <span>
                  Эти люди согласились получать сообщения от выбранного
                  отправителя. Источник указан выше. Отписки сохраняются при
                  повторном импорте.
                </span>
              </label>
              <p className="text-xs text-muted-foreground">
                Для личных сообщений через бота человек должен сначала начать с
                ним диалог. Телефон сам по себе не даёт боту такой возможности.
              </p>
            </div>
            <Button
              className="w-full"
              disabled={
                !result.valid.length ||
                source.trim().length < 3 ||
                !consent ||
                upload.isPending
              }
              onClick={() =>
                upload.mutate({
                  name: fileName,
                  fileType: "json",
                  content: JSON.stringify(result.valid.map(item => item.value)),
                  recipientType: mapping.type,
                  consentSource: source,
                  consentConfirmed: true,
                  permissionTransport,
                })
              }
            >
              {upload.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Сохранить {result.valid.length} получателей
            </Button>
          </>
        )}
        <input
          ref={input}
          type="file"
          className="hidden"
          accept=".xlsx,.csv,.json,.txt"
          aria-label="Файл получателей"
          onChange={e => {
            if (e.target.files?.[0]) void readFile(e.target.files[0]);
          }}
        />
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Сохранённые списки</h2>
        {lists.isLoading ? (
          <p className="text-sm text-muted-foreground">Загружаем списки…</p>
        ) : lists.error ? (
          <p role="alert" className="text-sm text-red-400">
            {lists.error.message}
          </p>
        ) : !lists.data?.length ? (
          <div className="rounded-xl border border-border p-8 text-center">
            <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              Первый список появится здесь после импорта.
            </p>
          </div>
        ) : (
          lists.data.map(list => (
            <div
              key={list.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{list.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {list.totalCount} получателей ·{" "}
                    {new Date(list.createdAt).toLocaleDateString("ru-RU")}
                  </p>
                </div>
                <Button
                  aria-label="Показать получателей"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setExpanded(expanded === list.id ? null : list.id)
                  }
                >
                  <Eye className="h-4 w-4" />
                </Button>
                <Button
                  aria-label="Удалить список"
                  size="icon"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (confirm(`Удалить список «${list.name}»?`))
                      remove.mutate({ id: list.id });
                  }}
                >
                  <Trash2 className="h-4 w-4 text-red-400" />
                </Button>
              </div>
              {expanded === list.id && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {(JSON.parse(list.chatIds) as string[])
                    .slice(0, 20)
                    .map((id, index) => (
                      <code
                        key={index}
                        className="text-xs rounded bg-muted px-2 py-1"
                      >
                        {id}
                      </code>
                    ))}
                </div>
              )}
              <AudienceSource listId={list.id} listName={list.name} />
            </div>
          ))
        )}
      </section>
      <ContactPermission />
    </div>
  );
}
