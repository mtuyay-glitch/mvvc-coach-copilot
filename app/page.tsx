"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type Role = "user" | "assistant";

type Message = {
  id: string;
  role: Role;
  text: string;
};

function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "assistant",
      text:
        "I’m **Volleyball Guru** for MVVC 14 Black.\n\n" +
        "Ask me about stats, month-over-month trends, lineups (including 6-2), strengths/weaknesses, tactics vs opponents, or player development.",
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const canSend = useMemo(() => input.trim() && !isSending, [input, isSending]);

  async function sendMessage() {
    if (!canSend) return;

    const question = input.trim();
    setInput("");
    setIsSending(true);

    const userMsg: Message = { id: uid(), role: "user", text: question };
    const thinkingId = uid();

    setMessages((m) => [
      ...m,
      userMsg,
      { id: thinkingId, role: "assistant", text: "Thinking…" },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const data = await res.json();

      const answer =
        typeof data?.answer === "string" && data.answer.trim()
          ? data.answer
          : "No answer generated.";

      setMessages((msgs) =>
        msgs.map((m) =>
          m.id === thinkingId ? { ...m, text: answer } : m
        )
      );
    } catch (e: any) {
      setMessages((msgs) =>
        msgs.map((m) =>
          m.id === thinkingId
            ? { ...m, text: "Something went wrong. Check the server logs." }
            : m
        )
      );
    } finally {
      setIsSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f9fafb",
        color: "#111827",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "16px",
          borderBottom: "1px solid #e5e7eb",
          fontWeight: 700,
          fontSize: 16,
        }}
      >
       
