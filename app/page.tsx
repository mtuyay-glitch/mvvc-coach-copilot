"use client";

import { useState } from "react";

type Msg = {
  role: "user" | "assistant";
  content: string;
};

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    const question = input.trim();
    if (!question) return;

    const nextMessages: Msg[] = [
      ...messages,
      { role: "user", content: question },
    ];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const json = await res.json();

      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: json.answer || "No response generated.",
        },
      ]);
    } catch (e) {
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: "Error contacting server.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen p-4 max-w-3xl mx-auto">
      <h1 className="text-xl font-semibold mb-4 text-white">
        MVVC Volleyball Guru
      </h1>

      <div className="space-y-4 mb-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-lg p-3 ${
              m.role === "user"
                ? "bg-slate-800 text-white"
                : "bg-slate-900 text-slate-100"
            }`}
          >
            <div className="text-xs uppercase tracking-wide opacity-70 mb-1">
              {m.role === "user" ? "You" : "Volleyball Guru"}
            </div>

            <div className="whitespace-pre-wrap leading-relaxed">
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="bg-slate-900 text-slate-100 rounded-lg p-3">
            <div className="text-xs uppercase tracking-wide opacity-70 mb-1">
              Volleyball Guru
            </div>
            Thinking…
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about the team…"
          className="flex-1 rounded-md px-3 py-2 bg-slate-800 text-white outline-none"
        />
        <button
          onClick={send}
          className="rounded-md px-4 py-2 bg-blue-600 text-white font-medium"
        >
          Send
        </button>
      </div>
    </main>
  );
}
