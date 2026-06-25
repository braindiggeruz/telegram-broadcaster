import { useState, useEffect } from "react";
import { MessageSquare, Eye, Code2, AlignLeft, Hash, Info, Copy, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const TEMPLATES = [
  { label: "Announcement", text: "<b>📢 Important Announcement</b>\n\nDear users,\n\nWe have an exciting update to share with you.\n\n<i>Stay tuned for more details!</i>" },
  { label: "Promotion", text: "<b>🎉 Special Offer!</b>\n\nFor a limited time only:\n• 50% off all plans\n• Free premium features\n• Priority support\n\n<a href='https://example.com'>Learn more →</a>" },
  { label: "Reminder", text: "<b>⏰ Reminder</b>\n\nThis is a friendly reminder about your upcoming event.\n\nDate: <code>2024-01-15</code>\nTime: <code>10:00 AM UTC</code>\n\nSee you there!" },
];

function renderTelegramHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;b&gt;([\s\S]*?)&lt;\/b&gt;/g, "<strong>$1</strong>")
    .replace(/&lt;i&gt;([\s\S]*?)&lt;\/i&gt;/g, "<em>$1</em>")
    .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, "<u>$1</u>")
    .replace(/&lt;s&gt;([\s\S]*?)&lt;\/s&gt;/g, "<s>$1</s>")
    .replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>')
    .replace(/&lt;pre&gt;([\s\S]*?)&lt;\/pre&gt;/g, '<pre class="bg-muted rounded p-2 text-xs font-mono overflow-x-auto">$1</pre>')
    .replace(/&lt;a href='([\s\S]*?)'&gt;([\s\S]*?)&lt;\/a&gt;/g, '<a href="$1" class="text-primary underline" target="_blank">$2</a>')
    .replace(/\n/g, "<br/>");
}

function renderMarkdown(text: string) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/__(.*?)__/g, "<u>$1</u>")
    .replace(/~~(.*?)~~/g, "<s>$1</s>")
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-primary underline" target="_blank">$1</a>')
    .replace(/\n/g, "<br/>");
}

const CHAR_LIMIT = 4096;

export default function Composer() {
  const [message, setMessage] = useState(TEMPLATES[0].text);
  const [mode, setMode] = useState<"HTML" | "Markdown">("HTML");
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  const charCount = message.length;
  const charPercent = Math.min((charCount / CHAR_LIMIT) * 100, 100);
  const charColor = charCount > CHAR_LIMIT ? "text-red-400" : charCount > CHAR_LIMIT * 0.8 ? "text-yellow-400" : "text-muted-foreground";

  const rendered = mode === "HTML" ? renderTelegramHtml(message) : renderMarkdown(message);

  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success("Message copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  // Save to sessionStorage for use in BroadcastLaunch
  useEffect(() => {
    sessionStorage.setItem("composer_message", message);
    sessionStorage.setItem("composer_mode", mode);
  }, [message, mode]);

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Message Composer</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Craft your broadcast message with rich formatting support.</p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Mode Toggle */}
        <div className="flex items-center rounded-lg border border-border bg-muted/30 p-1">
          {(["HTML", "Markdown"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150",
                mode === m ? "bg-primary text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m === "HTML" ? <Code2 className="h-3.5 w-3.5" /> : <AlignLeft className="h-3.5 w-3.5" />}
              {m}
            </button>
          ))}
        </div>

        {/* Preview Toggle */}
        <button
          onClick={() => setShowPreview(!showPreview)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-150",
            showPreview
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
        >
          <Eye className="h-3.5 w-3.5" />
          {showPreview ? "Hide Preview" : "Show Preview"}
        </button>

        {/* Templates */}
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-xs text-muted-foreground">Templates:</span>
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              onClick={() => { setMessage(t.text); toast.success(`Template "${t.label}" loaded`); }}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Editor + Preview */}
      <div className={cn("grid gap-4", showPreview ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1")}>
        {/* Editor */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 bg-muted/20">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium text-foreground">Editor — {mode}</span>
            </div>
            <button onClick={handleCopy} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              {copied ? <CheckCheck className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={mode === "HTML"
              ? "<b>Bold text</b>\n<i>Italic text</i>\n<code>code</code>"
              : "**Bold text**\n*Italic text*\n`code`"
            }
            className="w-full resize-none bg-transparent px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
            style={{ minHeight: "280px" }}
          />
          {/* Char counter */}
          <div className="border-t border-border px-4 py-2.5 bg-muted/20">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <Hash className="h-3 w-3 text-muted-foreground" />
                <span className={cn("text-xs font-mono font-medium", charColor)}>
                  {charCount.toLocaleString()} / {CHAR_LIMIT.toLocaleString()}
                </span>
              </div>
              {charCount > CHAR_LIMIT && (
                <span className="text-xs text-red-400 font-medium">Message too long!</span>
              )}
            </div>
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-300",
                  charCount > CHAR_LIMIT ? "bg-red-500" : charCount > CHAR_LIMIT * 0.8 ? "bg-yellow-500" : "bg-primary"
                )}
                style={{ width: `${charPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Preview */}
        {showPreview && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 bg-muted/20">
              <Eye className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium text-foreground">Live Preview</span>
            </div>
            {/* Telegram-like preview */}
            <div className="p-4">
              <div className="rounded-2xl rounded-tl-sm bg-[oklch(0.18_0.016_265)] px-4 py-3 max-w-xs">
                <div
                  className="text-sm text-foreground leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: rendered || '<span class="text-muted-foreground/50 text-xs">Start typing to see preview…</span>' }}
                />
                <div className="flex items-center justify-end gap-1 mt-2">
                  <span className="text-[10px] text-muted-foreground/60">
                    {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <CheckCheck className="h-3 w-3 text-primary/60" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Formatting Guide */}
      <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Info className="h-3.5 w-3.5 text-primary" />
          <p className="text-xs font-semibold text-foreground">{mode} Formatting Reference</p>
        </div>
        {mode === "HTML" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {[
              { tag: "<b>text</b>", result: "Bold" },
              { tag: "<i>text</i>", result: "Italic" },
              { tag: "<u>text</u>", result: "Underline" },
              { tag: "<s>text</s>", result: "Strikethrough" },
              { tag: "<code>text</code>", result: "Inline code" },
              { tag: "<pre>text</pre>", result: "Code block" },
              { tag: "<a href='…'>text</a>", result: "Link" },
            ].map(({ tag, result }) => (
              <div key={tag} className="rounded-lg bg-muted px-2.5 py-2">
                <code className="text-[10px] font-mono text-primary block truncate">{tag}</code>
                <span className="text-[10px] text-muted-foreground">{result}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {[
              { tag: "**text**", result: "Bold" },
              { tag: "*text*", result: "Italic" },
              { tag: "__text__", result: "Underline" },
              { tag: "~~text~~", result: "Strikethrough" },
              { tag: "`text`", result: "Inline code" },
              { tag: "[text](url)", result: "Link" },
            ].map(({ tag, result }) => (
              <div key={tag} className="rounded-lg bg-muted px-2.5 py-2">
                <code className="text-[10px] font-mono text-primary block truncate">{tag}</code>
                <span className="text-[10px] text-muted-foreground">{result}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
