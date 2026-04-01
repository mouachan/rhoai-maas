import React from "react";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  meta?: string;
  isStreaming?: boolean;
}

export function ChatMessage({ role, content, meta, isStreaming }: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 16,
      }}
    >
      <div style={{ maxWidth: "75%" }}>
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 12,
            borderBottomRightRadius: isUser ? 4 : 12,
            borderBottomLeftRadius: isUser ? 12 : 4,
            background: isUser ? "#cc0000" : "#f0f2f5",
            color: isUser ? "#fff" : "#1a1a2e",
            fontSize: 14,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {content || (isStreaming ? "Thinking..." : "")}
        </div>
        {meta && (
          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}
