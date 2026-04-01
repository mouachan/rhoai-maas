import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  PageSection,
  Title,
  Grid,
  GridItem,
  Card,
  CardTitle,
  CardBody,
  FormGroup,
  FormSelect,
  FormSelectOption,
  TextInput,
  Button,
  Spinner,
  Progress,
  ProgressMeasureLocation,
  Alert,
  Content,
} from "@patternfly/react-core";
import { useAuth } from "../AuthContext";
import { fetchModels, streamChat } from "../api";
import { ChatMessage } from "../components/ChatMessage";
import { TierBadge } from "../components/TierBadge";
import type { MaaSModel, Session } from "../types";

interface Message {
  role: "user" | "assistant";
  content: string;
  meta?: string;
  isStreaming?: boolean;
}

export function Playground() {
  const { session, updateSession } = useAuth();
  const [searchParams] = useSearchParams();
  const [models, setModels] = useState<MaaSModel[]>([]);
  const [selectedModel, setSelectedModel] = useState(
    searchParams.get("model") || ""
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<[string, string][]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return;
    fetchModels(session)
      .then((m) => {
        setModels(m);
        if (!selectedModel && m.length > 0) {
          setSelectedModel(m[0].id);
        }
      })
      .catch(() => setModels([]));
  }, [session]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !session || sending) return;
    const msg = input.trim();
    setInput("");
    setSending(true);

    // Add user message
    setMessages((prev) => [...prev, { role: "user", content: msg }]);

    // Add streaming assistant message
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", isStreaming: true },
    ]);

    let fullText = "";
    let meta = "";

    try {
      for await (const event of streamChat(session, msg, history, selectedModel || undefined)) {
        if (event.type === "token") {
          fullText += event.content || "";
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: fullText,
              isStreaming: true,
            };
            return updated;
          });
        } else if (event.type === "error") {
          fullText = event.content || "Error";
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: fullText,
              isStreaming: false,
            };
            return updated;
          });
        } else if (event.type === "done") {
          meta = event.meta || "";
          if (event.session) {
            updateSession(event.session);
          }
          setHistory((prev) => [...prev, [msg, fullText]]);
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: fullText,
              meta,
              isStreaming: false,
            };
            return updated;
          });
        }
      }
    } catch (e) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: `Error: ${e}`,
          isStreaming: false,
        };
        return updated;
      });
    }

    setSending(false);
  };

  const clearChat = () => {
    setMessages([]);
    setHistory([]);
  };

  if (!session) return null;

  const totalTokens = session.prompt_tokens + session.completion_tokens;
  const reqPct = session.req_limit
    ? Math.min(100, (session.requests / session.req_limit) * 100)
    : 0;
  const tokPct = session.token_limit
    ? Math.min(100, (totalTokens / session.token_limit) * 100)
    : 0;
  const avgLatency =
    session.latencies.length > 0
      ? session.latencies.reduce((a, b) => a + b, 0) / session.latencies.length
      : 0;

  return (
    <PageSection>
      <Title headingLevel="h1" style={{ marginBottom: 16 }}>
        Playground
      </Title>

      {/* Model selector */}
      <FormGroup label="Model" fieldId="model-select" style={{ marginBottom: 16, maxWidth: 500 }}>
        <FormSelect
          id="model-select"
          value={selectedModel}
          onChange={(_e, val) => setSelectedModel(val)}
        >
          {models.length === 0 && (
            <FormSelectOption value="" label="Loading models..." />
          )}
          {models.map((m) => (
            <FormSelectOption key={m.id} value={m.id} label={m.name || m.id} />
          ))}
        </FormSelect>
      </FormGroup>

      <Grid hasGutter>
        {/* Chat area */}
        <GridItem span={8}>
          <Card style={{ height: "calc(100vh - 280px)", display: "flex", flexDirection: "column" }}>
            <CardBody style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {messages.length === 0 && (
                <div style={{ textAlign: "center", color: "#6c757d", paddingTop: 60 }}>
                  <Content component="p">
                    Start a conversation with the model
                  </Content>
                </div>
              )}
              {messages.map((msg, i) => (
                <ChatMessage
                  key={i}
                  role={msg.role}
                  content={msg.content}
                  meta={msg.meta}
                  isStreaming={msg.isStreaming}
                />
              ))}
              <div ref={messagesEndRef} />
            </CardBody>
            <div style={{ borderTop: "1px solid #eee", padding: 16 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <Button variant="secondary" onClick={clearChat} size="sm">
                  Clear Chat
                </Button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <TextInput
                  value={input}
                  onChange={(_e, val) => setInput(val)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask the model anything..."
                  isDisabled={sending}
                  aria-label="Chat input"
                />
                <Button
                  variant="primary"
                  onClick={handleSend}
                  isDisabled={sending || !input.trim()}
                  isLoading={sending}
                >
                  Send
                </Button>
              </div>
            </div>
          </Card>
        </GridItem>

        {/* Sidebar */}
        <GridItem span={4}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* User info */}
            <Card
              style={{
                background: "linear-gradient(135deg, #1a1a2e, #16213e)",
                color: "#fff",
              }}
            >
              <CardBody>
                <Content component="small" style={{ color: "rgba(255,255,255,0.7)" }}>
                  User
                </Content>
                <div style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 12px" }}>
                  {session.username}
                </div>
                <TierBadge tier={session.tier} />
              </CardBody>
            </Card>

            {/* Stats */}
            <Card>
              <CardBody>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                  }}
                >
                  <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 12, textAlign: "center" }}>
                    <Content component="small">Requests</Content>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>
                      {session.requests}
                    </div>
                  </div>
                  <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 12, textAlign: "center" }}>
                    <Content component="small">Tokens</Content>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>
                      {totalTokens}
                    </div>
                  </div>
                  <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 12, textAlign: "center" }}>
                    <Content component="small">Prompt</Content>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#3498db" }}>
                      {session.prompt_tokens}
                    </div>
                  </div>
                  <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 12, textAlign: "center" }}>
                    <Content component="small">Completion</Content>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#27ae60" }}>
                      {session.completion_tokens}
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Latency */}
            <Card>
              <CardBody>
                <Content component="small">Avg Latency</Content>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {avgLatency.toFixed(2)}s
                </div>
              </CardBody>
            </Card>

            {/* Rate limits */}
            <Card>
              <CardBody>
                <Progress
                  value={reqPct}
                  title={`Requests (${session.requests}/${session.req_limit || "-"} per ${session.req_window})`}
                  measureLocation={ProgressMeasureLocation.top}
                  variant={
                    reqPct >= 90
                      ? "danger"
                      : reqPct >= 70
                        ? "warning"
                        : undefined
                  }
                  style={{ marginBottom: 16 }}
                />
                <Progress
                  value={tokPct}
                  title={`Tokens (${totalTokens}/${session.token_limit || "-"} per ${session.token_window})`}
                  measureLocation={ProgressMeasureLocation.top}
                  variant={
                    tokPct >= 90
                      ? "danger"
                      : tokPct >= 70
                        ? "warning"
                        : undefined
                  }
                />
              </CardBody>
            </Card>

            {/* Rate limit alert */}
            {session.rate_limited > 0 && (
              <Alert variant="danger" title="Rate Limited" isInline>
                {session.rate_limited} requests rejected
              </Alert>
            )}
          </div>
        </GridItem>
      </Grid>
    </PageSection>
  );
}
