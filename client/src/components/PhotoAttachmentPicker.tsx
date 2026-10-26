import { useEffect, useRef, useState, type DragEvent } from "react";
import type { PhotoAttachment } from "@shared/media";
import { trpc } from "@/lib/trpc";
import { photoSize, preparePhoto, type PreparedPhoto } from "@/lib/photo";
import { Button } from "@/components/ui/button";
import { ImagePlus, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";

export type PreviewPhoto = Pick<PhotoAttachment, "url" | "name">;
type State = "idle" | "processing" | "uploading" | "error";

export default function PhotoAttachmentPicker({
  photo,
  disabled,
  onChange,
  onSelectionStart,
  onBlockedChange,
  onPreviewChange,
}: {
  photo: PhotoAttachment | null;
  disabled?: boolean;
  onChange: (photo: PhotoAttachment | null) => void;
  onSelectionStart: () => void;
  onBlockedChange: (blocked: boolean) => void;
  onPreviewChange: (photo: PreviewPhoto | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const retryFile = useRef<File | null>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<PreparedPhoto | null>(null);
  const upload = trpc.media.uploadPhoto.useMutation();
  const pending = state === "processing" || state === "uploading";

  useEffect(() => {
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (
        event.dataTransfer &&
        Array.from(event.dataTransfer.types).includes("Files")
      )
        event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      sequence.current++;
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [pending]);

  const resetSelection = () => {
    sequence.current++;
    retryFile.current = null;
    setPrepared(null);
    setError("");
    setState("idle");
    onPreviewChange(null);
    onBlockedChange(false);
    if (input.current) input.current.value = "";
  };
  const select = async (files: File[]) => {
    if (disabled) return;
    const request = ++sequence.current;
    onSelectionStart();
    onBlockedChange(true);
    onPreviewChange(null);
    setPrepared(null);
    setError("");
    retryFile.current = files.length === 1 ? files[0] : null;
    if (files.length !== 1) {
      setState("error");
      setError(
        "Прикрепите одну картинку. Альбом из нескольких файлов пока не поддерживается."
      );
      return;
    }
    setState("processing");
    try {
      const value = await preparePhoto(files[0]);
      if (request !== sequence.current) return;
      setPrepared(value);
      onPreviewChange({ url: value.previewUrl, name: value.name });
      setState("uploading");
      const saved = await upload.mutateAsync({
        name: value.name,
        mimeType: value.mimeType,
        dataBase64: value.dataBase64,
      });
      if (request !== sequence.current) return;
      onChange(saved);
      setState("idle");
      setPrepared(null);
      retryFile.current = null;
      onPreviewChange(null);
      onBlockedChange(false);
    } catch (cause) {
      if (request !== sequence.current) return;
      setState("error");
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить картинку. Повторите попытку."
      );
    }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (!disabled) void select(Array.from(event.dataTransfer.files));
  };
  const visible = prepared
    ? {
        url: prepared.previewUrl,
        name: prepared.name,
        size: prepared.size,
        width: prepared.width,
        height: prepared.height,
      }
    : photo;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span id="campaign-photo-label" className="text-sm font-medium">
          Картинка{" "}
          <span className="font-normal text-muted-foreground">
            · необязательно
          </span>
        </span>
        {photo && state === "idle" && (
          <span className="text-xs text-emerald-400">Загружена</span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="sr-only"
        aria-label="Выбрать картинку для рассылки"
        disabled={disabled}
        tabIndex={-1}
        onChange={event => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) void select(files);
          event.target.value = "";
        }}
      />
      <div
        className={`relative rounded-xl border-2 border-dashed p-4 transition-colors ${dragging ? "border-primary bg-primary/10" : "border-border bg-background/40"} ${disabled ? "opacity-60" : ""}`}
        aria-labelledby="campaign-photo-label"
        onDragEnter={event => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            event.preventDefault();
            dragDepth.current++;
            if (!disabled) setDragging(true);
          }
        }}
        onDragOver={event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = disabled ? "none" : "copy";
        }}
        onDragLeave={event => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={drop}
      >
        {visible ? (
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={visible.url}
              alt={`Прикреплённая картинка: ${visible.name}`}
              className="h-20 w-20 shrink-0 rounded-lg object-cover bg-muted"
            />
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium" title={visible.name}>
                {visible.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {visible.width} × {visible.height} · {photoSize(visible.size)}
              </p>
              <p className="text-xs text-muted-foreground">
                Перетащите сюда другую картинку для замены
              </p>
            </div>
          </div>
        ) : (
          <div className="py-3 text-center space-y-2">
            <ImagePlus
              className="h-7 w-7 mx-auto text-primary"
              aria-hidden="true"
            />
            <p className="text-sm font-medium">Перетащите картинку сюда</p>
            <p className="text-xs text-muted-foreground">
              или выберите файл на устройстве
            </p>
          </div>
        )}
        <div
          className={`flex flex-wrap items-center gap-2 ${visible ? "mt-3" : "mt-1 justify-center"}`}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {visible ? "Заменить" : "Выбрать картинку"}
          </Button>
          {(visible || pending || state === "error") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                resetSelection();
                onSelectionStart();
                onChange(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Убрать
            </Button>
          )}
        </div>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/90 text-sm font-medium text-primary">
            Отпустите, чтобы прикрепить
          </div>
        )}
      </div>
      <div
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {pending ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {state === "processing"
              ? "Подготавливаем картинку…"
              : "Загружаем и сохраняем картинку…"}
          </span>
        ) : (
          state !== "error" &&
          "JPEG, PNG или WebP до 20 МБ. Размер и вес оптимизируем автоматически."
        )}
      </div>
      {state === "error" && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/25 bg-red-500/5 p-3 space-y-2"
        >
          <p className="text-xs text-red-400">{error}</p>
          <div className="flex flex-wrap gap-2">
            {retryFile.current && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (retryFile.current) void select([retryFile.current]);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Повторить
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={resetSelection}
            >
              {photo ? "Вернуться к сохранённой" : "Отменить выбор"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
