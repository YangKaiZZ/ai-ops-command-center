"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardProvider";
import { ChatCircleDotsIcon, EraserIcon, PaperPlaneRightIcon } from "@/components/icons";
import { inputClass, Note, primaryButton, type Message } from "@/components/ui";
import {
  MAX_QUESTION,
  ordersSearchHref,
  questionsLeft,
  replyParts,
  storageKey,
  SUGGESTIONS,
  toolsLine,
  toSend,
  type ChatMessage,
  type ChatReply,
  type ChatStatus,
} from "@/lib/chat";
import { jsonBody, useApi } from "@/lib/useApi";

// The conversation is kept for this tab only (sessionStorage), never on the server.
function loadHistory(key: string): ChatMessage[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveHistory(key: string, history: ChatMessage[]) {
  try {
    if (history.length) sessionStorage.setItem(key, JSON.stringify(history));
    else sessionStorage.removeItem(key);
  } catch {
    // Storage full or blocked: the conversation still works, it just isn't kept.
  }
}

// A reply with each order number linked to the Orders page, searched for it.
function Reply({ text }: { text: string }) {
  return (
    <>
      {replyParts(text).map((part, i) =>
        part.order ? (
          <Link key={i} href={ordersSearchHref(part.order)} className="font-medium text-accent underline-offset-2 hover:underline">
            {part.text}
          </Link>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <li className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-accent/10 px-3.5 py-2.5 text-sm text-ink">
        <span className="sr-only">You: </span>
        {message.content}
      </li>
    );
  }
  const looked = toolsLine(message.tools);
  return (
    <li className="mr-auto grid max-w-[92%] gap-1.5">
      <div className="whitespace-pre-wrap break-words rounded-xl rounded-bl-sm border border-border bg-page px-3.5 py-2.5 text-sm leading-relaxed">
        <span className="sr-only">Assistant: </span>
        <Reply text={message.content} />
      </div>
      {looked && <p className="px-1 font-mono text-xs text-ink-2">{looked}</p>}
    </li>
  );
}

// Mounted again for another account (its own storage key), so one seller's
// conversation never shows for the next one signed in on this tab.
export default function ChatPage() {
  const { session } = useDashboard();
  const key = storageKey(session.token);
  return <Chat key={key} storageKey={key} />;
}

function Chat({ storageKey: key }: { storageKey: string }) {
  const { data } = useDashboard();
  const api = useApi();
  // The dashboard renders only once signed in, in the browser, so the saved
  // conversation can be read right away.
  const [history, setHistory] = useState<ChatMessage[]>(() => loadHistory(key));
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [asked, setAsked] = useState(0); // questions sent here, so the count reloads after each
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const loaded = data != null;
  const isDemo = Boolean(data?.settings.demo);

  // Whether chat can be used, and today's count. The demo has it off (the form says so).
  useEffect(() => {
    if (!loaded || isDemo) return;
    let cancelled = false;
    api<ChatStatus>("/api/chat")
      .then((body) => {
        if (!cancelled) setStatus(body);
      })
      .catch(() => {
        // Nothing to show: sending a question says what's wrong.
      });
    return () => {
      cancelled = true;
    };
  }, [api, loaded, isDemo, asked]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history, asking]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || asking) return;
    const before = history;
    const withQuestion: ChatMessage[] = [...before, { role: "user", content: q }];
    setHistory(withQuestion);
    setQuestion("");
    setMessage(null);
    setAsking(true);
    try {
      const { reply, tools_used } = await api<ChatReply>("/api/chat", { method: "POST", ...jsonBody({ messages: toSend(before, q) }) });
      const next: ChatMessage[] = [...withQuestion, { role: "assistant", content: reply, tools: tools_used }];
      setHistory(next);
      saveHistory(key, next);
    } catch (err) {
      // The question goes back in the box, so it can be sent again.
      setHistory(before);
      setQuestion(q);
      setMessage({ text: err instanceof Error ? err.message : "Couldn't send that.", isError: true });
    } finally {
      setAsking(false);
      setAsked((n) => n + 1);
      input.current?.focus();
    }
  };

  const clear = () => {
    setHistory([]);
    saveHistory(key, []);
    setMessage(null);
    input.current?.focus();
  };

  const left = questionsLeft(status);
  const unavailable = isDemo
    ? "Chat is off in the demo: each question is answered by an AI model reading your store, and the demo makes no model calls. Sign up to use it with your own store."
    : status && !status.available
      ? "Chat isn't set up on this server yet."
      : null;
  const noStore = data != null && !data.settings.store.connected && !isDemo;

  return (
    <section className="grid min-w-0 gap-4 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <ChatCircleDotsIcon aria-hidden="true" className="size-4 text-accent" />
            Ask about your store
          </h2>
          <p className="text-sm text-ink-2">
            Answers come from your orders, stock and the agent&apos;s decisions, read with the same tools the agent uses. It can&apos;t change
            anything in your store.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {left && <span className="font-mono text-xs text-ink-2">{left}</span>}
          {history.length > 0 && (
            <button
              type="button"
              onClick={clear}
              disabled={asking}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
            >
              <EraserIcon aria-hidden="true" className="size-4" />
              Clear
            </button>
          )}
        </div>
      </div>

      {unavailable && <p className="rounded-lg border border-border bg-page px-3.5 py-2.5 text-sm text-ink-2">{unavailable}</p>}
      {noStore && !unavailable && (
        <p className="rounded-lg border border-border bg-page px-3.5 py-2.5 text-sm text-ink-2">
          Connect your store in <Link href="/settings" className="font-medium text-accent hover:underline">Settings</Link> first: until then
          there are no orders or stock to ask about.
        </p>
      )}

      {history.length === 0 && !unavailable ? (
        <div className="grid gap-2">
          <p className="text-sm text-ink-2">Try one of these, or ask your own:</p>
          <ul className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => ask(s)}
                  disabled={asking}
                  className="rounded-full border border-border bg-page px-3 py-1.5 text-left text-sm text-ink transition-colors hover:border-accent/40 hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol aria-label="Conversation" aria-live="polite" className="grid max-h-[60vh] min-h-40 content-start gap-3 overflow-y-auto pr-1">
          {history.map((m, i) => (
            <Bubble key={i} message={m} />
          ))}
          {asking && (
            <li className="mr-auto flex items-center gap-2 rounded-xl border border-border bg-page px-3.5 py-2.5 text-sm text-ink-2" role="status">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
              Looking it up…
            </li>
          )}
          <div ref={listEnd} />
        </ol>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="grid gap-2"
      >
        <div className="flex items-end gap-2">
          <label htmlFor="chat-question" className="sr-only">
            Your question
          </label>
          <textarea
            id="chat-question"
            ref={input}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a new line.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(question);
              }
            }}
            rows={2}
            maxLength={MAX_QUESTION}
            disabled={Boolean(unavailable)}
            placeholder="e.g. Which orders from this week are still unpaid?"
            className={`${inputClass} resize-none`}
          />
          <button
            type="submit"
            disabled={asking || !question.trim() || Boolean(unavailable)}
            className={`${primaryButton} inline-flex items-center gap-2 disabled:cursor-not-allowed`}
          >
            <PaperPlaneRightIcon aria-hidden="true" weight="bold" className="size-4" />
            Ask
          </button>
        </div>
        <Note message={message} />
      </form>
    </section>
  );
}
