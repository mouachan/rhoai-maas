import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PageSection,
  Card,
  CardTitle,
  CardBody,
  Title,
  Button,
  Grid,
  GridItem,
  Spinner,
  Content,
} from "@patternfly/react-core";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { useAuth } from "../AuthContext";
import { TierBadge } from "../components/TierBadge";
import { fetchModels, fetchKeys, fetchUsageStats } from "../api";
import type { UsageStats } from "../types";

const COLORS = ["#4a5568", "#3498db", "#27ae60", "#f39c12", "#9b59b6", "#1abc9c"];

export function Dashboard() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [modelCount, setModelCount] = useState<number | null>(null);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);

  useEffect(() => {
    if (!session) return;
    fetchModels(session).then((m) => setModelCount(m.length)).catch(() => setModelCount(0));
    fetchKeys(session).then((k) => setKeyCount(k.length)).catch(() => setKeyCount(0));
    fetchUsageStats().then(setUsage).catch(() => {});
  }, [session]);

  if (!session) return null;

  const kpiStyle = {
    textAlign: "center" as const,
    padding: "20px 16px",
  };
  const kpiValue = {
    fontSize: 32,
    fontWeight: 700,
    lineHeight: 1.2,
  };
  const kpiLabel = {
    fontSize: 12,
    color: "#6c757d",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginTop: 4,
  };

  const tokenPieData = usage
    ? [
        { name: "Prompt", value: usage.total_prompt_tokens },
        { name: "Completion", value: usage.total_completion_tokens },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <PageSection>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <Title headingLevel="h1" size="2xl">
            Dashboard
          </Title>
          <Content component="p" style={{ color: "#6c757d", marginTop: 4 }}>
            Welcome back, <strong>{session.username}</strong> <TierBadge tier={session.tier} />
          </Content>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="primary" onClick={() => navigate("/playground")}>
            Open Playground
          </Button>
          <Button variant="secondary" onClick={() => navigate("/usage")}>
            View Usage
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <Grid hasGutter>
        <GridItem span={3}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#4a5568" }}>
                {modelCount === null ? <Spinner size="md" /> : modelCount}
              </div>
              <div style={kpiLabel}>Models</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={3}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#3498db" }}>
                {keyCount === null ? <Spinner size="md" /> : keyCount}
              </div>
              <div style={kpiLabel}>API Keys</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={3}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#27ae60" }}>{usage?.total_requests ?? 0}</div>
              <div style={kpiLabel}>Total Requests</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={3}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#f39c12" }}>
                {usage?.total_tokens?.toLocaleString() ?? 0}
              </div>
              <div style={kpiLabel}>Total Tokens</div>
            </CardBody>
          </Card>
        </GridItem>
      </Grid>

      {/* Tier Limits + Token breakdown */}
      <Grid hasGutter style={{ marginTop: 16 }}>
        <GridItem span={4}>
          <Card isFullHeight>
            <CardTitle>Tier Limits</CardTitle>
            <CardBody>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <div style={kpiLabel}>Request Limit</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{session.req_limit || "N/A"}</div>
                  <div style={{ fontSize: 12, color: "#999" }}>per {session.req_window}</div>
                </div>
                <div>
                  <div style={kpiLabel}>Token Limit</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>
                    {session.token_limit?.toLocaleString() || "N/A"}
                  </div>
                  <div style={{ fontSize: 12, color: "#999" }}>per {session.token_window}</div>
                </div>
              </div>
              <div style={{ marginTop: 20 }}>
                <Button variant="link" style={{ paddingLeft: 0 }} onClick={() => navigate("/models")}>
                  Browse Models
                </Button>
                <span style={{ margin: "0 8px", color: "#ccc" }}>|</span>
                <Button variant="link" style={{ paddingLeft: 0 }} onClick={() => navigate("/api-keys")}>
                  Manage API Keys
                </Button>
              </div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={4}>
          <Card isFullHeight>
            <CardTitle>Token Breakdown</CardTitle>
            <CardBody>
              {tokenPieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={tokenPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" label>
                      {tokenPieData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ textAlign: "center", color: "#999", paddingTop: 40 }}>
                  No usage data yet. Start chatting in the Playground.
                </div>
              )}
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={4}>
          <Card isFullHeight>
            <CardTitle>Requests by Model</CardTitle>
            <CardBody>
              {usage && usage.requests_by_model.length > 0 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={usage.requests_by_model} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="model" width={120} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="requests" fill="#4a5568" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ textAlign: "center", color: "#999", paddingTop: 40 }}>
                  No usage data yet.
                </div>
              )}
            </CardBody>
          </Card>
        </GridItem>
      </Grid>

      {/* Per-user usage */}
      {usage && usage.requests_by_user && usage.requests_by_user.length > 0 && (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Usage by User</CardTitle>
          <CardBody style={{ padding: 0 }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #eee", textAlign: "left" }}>
                  <th style={{ padding: "8px 12px" }}>User</th>
                  <th style={{ padding: "8px 12px" }}>Requests</th>
                  <th style={{ padding: "8px 12px" }}>Total Tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.requests_by_user.map((u) => (
                  <tr key={u.user} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "6px 12px", fontWeight: 600 }}>{u.user}</td>
                    <td style={{ padding: "6px 12px" }}>{u.requests}</td>
                    <td style={{ padding: "6px 12px" }}>{u.tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </PageSection>
  );
}
