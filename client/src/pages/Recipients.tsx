import { useState, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import {
  Users, Upload, FileJson, FileText, Trash2, Eye, EyeOff, Loader2,
  ArrowRight, CheckCircle2, AlertCircle, Hash, X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";

// Accepts phone numbers (+998…), numeric chat IDs and @usernames.
function normalizeRecipient(raw: string): string | null {
  const v = String(raw).trim();
  if (!v) return null;
  if (v.startsWith("@")) return v.length > 1 ? v : null;
  if (/^-?\d+$/.test(v)) return v;
  const digits = v.replace(/[^\d]/g, "");
  if (digits.length >= 10 && digits.length <= 15) return "+" + digits;
  return null;
}

// Strict phone matcher for spreadsheet cells: only real phone numbers (11-15 digits)
// or @usernames. Rejects short numeric cells like company names ("7").
function phoneCellFromExcel(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (v.startsWith("@")) return v.length > 1 ? v : null;
  const digits = v.replace(/[^\d]/g, "");
  if (digits.length >= 11 && digits.length <= 15) return "+" + digits;
  return null;
}

function FileUploadZone({ onFile }: { onFile: (name: string, content: string, type: "json" | "csv") => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "json" && ext !== "csv" && ext !== "xlsx" && ext !== "xls") {
      toast.error("Поддерживаются файлы JSON, CSV и Excel (.xlsx/.xls)");
      return;
    }
    const reader = new FileReader();
    if (ext === "xlsx" || ext === "xls") {
      // Excel: read all sheets and pick any cell that looks like a phone/@username/ID,
      // regardless of column position or stray values in the file.
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const wb = XLSX.read(data, { type: "array" });
          const found: string[] = [];
          for (const sheetName of wb.SheetNames) {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
              header: 1, raw: false, defval: "",
            }) as unknown[][];
            for (const row of rows) {
              for (const cell of row) {
                const norm = phoneCellFromExcel(cell);
                if (norm) found.push(norm);
              }
            }
          }
          const content = Array.from(new Set(found)).join("\n");
          if (!content) {
            toast.error("В Excel-файле не найдено номеров телефонов");
            return;
          }
          // Hand off as plain CSV content (one recipient per line).
          onFile(file.name, content, "csv");
        } catch {
          toast.error("Не удалось прочитать Excel-файл");
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => {
        const content = e.target?.result as string;
        onFile(file.name, content, ext as "json" | "csv");
      };
      reader.readAsText(file);
    }
  }, [onFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-all duration-200",
        dragging
          ? "border-primary bg-primary/10 scale-[1.01]"
          : "border-border bg-muted/20 hover:border-primary/50 hover:bg-muted/40"
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".json,.csv,.xlsx,.xls"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      <div className={cn(
        "flex h-14 w-14 items-center justify-center rounded-2xl transition-all duration-200",
        dragging ? "gradient-primary glow-primary" : "bg-muted"
      )}>
        <Upload className={cn("h-6 w-6", dragging ? "text-white" : "text-muted-foreground")} />
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-foreground">
          {dragging ? "Drop file here" : "Drag & drop or click to upload"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">Excel (.xlsx), CSV или JSON — номера (+998…), chat ID или @username. Номер находится автоматически в любой колонке.</p>
      </div>
      <div className="flex items-center gap-3 mt-1">
        <div className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5">
          <FileText className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-muted-foreground">.xlsx</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5">
          <FileJson className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-muted-foreground">.json</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5">
          <FileText className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-muted-foreground">.csv</span>
        </div>
      </div>
    </div>
  );
}

export default function Recipients() {
  const [preview, setPreview] = useState<{ name: string; content: string; type: "json" | "csv" } | null>(null);
  const [parsedIds, setParsedIds] = useState<string[]>([]);
  const [showPreviewIds, setShowPreviewIds] = useState(false);
  const [expandedList, setExpandedList] = useState<number | null>(null);

  const { data: lists, isLoading, refetch } = trpc.recipients.list.useQuery(undefined, {
  });

  const uploadMutation = trpc.recipients.upload.useMutation({
    onSuccess: (data) => {
      toast.success(`Uploaded ${data?.totalCount.toLocaleString()} recipients`);
      setPreview(null);
      setParsedIds([]);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.recipients.delete.useMutation({
    onSuccess: () => { toast.success("List deleted"); refetch(); },
    onError: (err) => toast.error(err.message),
  });

  const handleFile = (name: string, content: string, type: "json" | "csv") => {
    setPreview({ name, content, type });
    // Parse preview
    try {
      let raw: string[] = [];
      if (type === "json") {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) raw = parsed.map(String);
        else if (parsed.users) raw = parsed.users.map(String);
        else if (parsed.chat_ids) raw = parsed.chat_ids.map(String);
        else if (parsed.phones) raw = parsed.phones.map(String);
      } else {
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) raw.push(line.split(",")[0].trim());
      }
      const ids = raw.map(normalizeRecipient).filter((v): v is string => v !== null);
      setParsedIds(Array.from(new Set(ids)));
    } catch {
      setParsedIds([]);
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Recipients</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Upload and manage your recipient lists for broadcasts.</p>
      </div>

      {/* Upload Zone */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Upload Recipient List</h2>
        </div>

        {!preview ? (
          <FileUploadZone onFile={handleFile} />
        ) : (
          <div className="space-y-4">
            {/* File Preview Header */}
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                {preview.type === "json" ? <FileJson className="h-5 w-5 text-primary" /> : <FileText className="h-5 w-5 text-primary" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{preview.name}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Hash className="h-3 w-3" />
                    {parsedIds.length.toLocaleString()} unique recipients
                  </span>
                  {parsedIds.length > 0 && (
                    <span className="badge-success"><CheckCircle2 className="h-3 w-3" />Ready</span>
                  )}
                  {parsedIds.length === 0 && (
                    <span className="badge-failed"><AlertCircle className="h-3 w-3" />No valid IDs found</span>
                  )}
                </div>
              </div>
              <button onClick={() => { setPreview(null); setParsedIds([]); }} className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Preview IDs */}
            {parsedIds.length > 0 && (
              <div className="rounded-xl border border-border bg-muted/20 overflow-hidden">
                <button
                  onClick={() => setShowPreviewIds(!showPreviewIds)}
                  className="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <span>Preview chat IDs ({Math.min(parsedIds.length, 20)} of {parsedIds.length.toLocaleString()})</span>
                  {showPreviewIds ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                {showPreviewIds && (
                  <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto">
                    {parsedIds.slice(0, 20).map((id, i) => (
                      <code key={i} className="rounded bg-muted px-2 py-1 text-xs font-mono text-muted-foreground truncate">
                        {id}
                      </code>
                    ))}
                    {parsedIds.length > 20 && (
                      <div className="col-span-full text-xs text-muted-foreground text-center py-1">
                        +{(parsedIds.length - 20).toLocaleString()} more…
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Upload Button */}
            <button
              onClick={() => uploadMutation.mutate({ name: preview.name, content: preview.content, fileType: preview.type })}
              disabled={parsedIds.length === 0 || uploadMutation.isPending}
              className="w-full flex items-center justify-center gap-2 rounded-lg gradient-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {uploadMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Uploading…</>
              ) : (
                <><CheckCircle2 className="h-4 w-4" />Save {parsedIds.length.toLocaleString()} Recipients</>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Saved Lists */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Saved Lists</h2>
          <span className="text-xs text-muted-foreground">{lists?.length ?? 0} list{(lists?.length ?? 0) !== 1 ? "s" : ""}</span>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="rounded-xl border border-border bg-card p-4 animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-muted" />
                  <div className="space-y-2 flex-1">
                    <div className="h-3.5 w-40 bg-muted rounded" />
                    <div className="h-3 w-24 bg-muted rounded" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : lists?.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted mx-auto mb-3">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No recipient lists yet</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a JSON or CSV file to create your first list.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {lists?.map((list: any) => (
              <div key={list.id} className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="flex items-center gap-4 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                    {list.fileType === "json" ? <FileJson className="h-5 w-5 text-primary" /> : <FileText className="h-5 w-5 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{list.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <span className="font-medium text-foreground">{list.totalCount.toLocaleString()}</span> recipients · {new Date(list.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setExpandedList(expandedList === list.id ? null : list.id)}
                      className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title="Preview IDs"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${list.name}"?`)) deleteMutation.mutate({ id: list.id });
                      }}
                      className="rounded-lg p-2 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Delete list"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {expandedList === list.id && (
                  <div className="border-t border-border px-4 pb-4 pt-3 bg-muted/20">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Sample chat IDs:</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {JSON.parse(list.chatIds).slice(0, 12).map((id: string, i: number) => (
                        <code key={i} className="rounded bg-muted px-2 py-1 text-xs font-mono text-muted-foreground truncate">
                          {id}
                        </code>
                      ))}
                      {list.totalCount > 12 && (
                        <div className="col-span-full text-xs text-muted-foreground text-center py-1">
                          +{(list.totalCount - 12).toLocaleString()} more…
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Format Guide */}
      <div className="rounded-xl border border-border/50 bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground">Supported File Formats</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5"><FileJson className="h-3.5 w-3.5 text-primary" />JSON</p>
            <pre className="rounded-lg bg-muted px-3 py-2 text-xs font-mono text-muted-foreground overflow-x-auto">{`["+998901234567", "+998901112233"]
// or
{"phones": ["+998901234567"]}`}</pre>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 text-primary" />CSV</p>
            <pre className="rounded-lg bg-muted px-3 py-2 text-xs font-mono text-muted-foreground overflow-x-auto">{`phone
+998901234567
+998901112233`}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
