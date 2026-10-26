import React, { Fragment, useEffect, useState, type ReactNode } from "react";
import type { PhotoAttachment } from "@shared/media";

export function safePreviewUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ["https:", "http:", "tg:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Build React nodes only; unrecognised tags and attributes stay literal text. */
export function previewNodes(text: string, mode: string, depth = 0): ReactNode {
  if (depth > 8 || mode === "None") return text;
  const pattern =
    mode === "HTML"
      ? /<(b|strong|i|em|u|s|code|pre)>([\s\S]*?)<\/\1>|<a href=(?:"([^"<>]*)"|'([^'<>]*)')>([\s\S]*?)<\/a>/g
      : /\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)/g;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of Array.from(text.matchAll(pattern))) {
    nodes.push(text.slice(offset, match.index));
    if (mode === "HTML") {
      if (match[1]) {
        const tag = match[1],
          body = previewNodes(match[2], mode, depth + 1);
        nodes.push(
          tag === "b" || tag === "strong" ? (
            <strong>{body}</strong>
          ) : tag === "i" || tag === "em" ? (
            <em>{body}</em>
          ) : tag === "u" ? (
            <u>{body}</u>
          ) : tag === "s" ? (
            <s>{body}</s>
          ) : tag === "pre" ? (
            <pre className="overflow-auto rounded bg-black/20 p-2">
              {match[2]}
            </pre>
          ) : (
            <code className="rounded bg-black/20 px-1">{match[2]}</code>
          )
        );
      } else {
        const url = safePreviewUrl(match[3] ?? match[4]);
        nodes.push(
          url ? (
            <a
              href={url}
              rel="noopener noreferrer"
              target="_blank"
              className="text-primary underline"
            >
              {previewNodes(match[5], mode, depth + 1)}
            </a>
          ) : (
            match[5]
          )
        );
      }
    } else {
      const url = match[5] && safePreviewUrl(match[5]);
      nodes.push(
        match[1] ? (
          <strong>{match[1]}</strong>
        ) : match[2] ? (
          <em>{match[2]}</em>
        ) : match[3] ? (
          <code>{match[3]}</code>
        ) : url ? (
          <a
            href={url}
            rel="noopener noreferrer"
            target="_blank"
            className="text-primary underline"
          >
            {match[4]}
          </a>
        ) : (
          match[4]
        )
      );
    }
    offset = match.index! + match[0].length;
  }
  nodes.push(text.slice(offset));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

export default function MessagePreview({
  message,
  parseMode,
  photo,
}: {
  message: string;
  parseMode: string;
  photo?: Pick<PhotoAttachment, "url" | "name"> | null;
}) {
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    setImageError(false);
  }, [photo?.url]);
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl rounded-tl-sm border border-primary/15 bg-primary/5 text-sm leading-relaxed break-words">
        {photo &&
          (imageError ? (
            <p role="alert" className="p-4 text-xs text-amber-400">
              Не удалось показать картинку. Обновите страницу или выберите файл
              ещё раз.
            </p>
          ) : (
            <img
              src={photo.url}
              alt={`Картинка сообщения: ${photo.name}`}
              onError={() => setImageError(true)}
              className="block max-h-80 w-full object-contain bg-black/10"
            />
          ))}
        {(message || !photo) && (
          <div className="p-4 whitespace-pre-wrap">
            {message ? (
              previewNodes(message, parseMode)
            ) : (
              <span className="text-muted-foreground">
                Здесь появится ваше сообщение
              </span>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Приблизительный предпросмотр. Неподдерживаемая разметка показана как
        текст; окончательную проверку форматирования выполняет Telegram.
      </p>
    </div>
  );
}
