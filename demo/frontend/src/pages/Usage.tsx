import { useEffect, useState } from "react";
import {
  PageSection,
  Title,
  Spinner,
  Card,
  CardTitle,
  CardBody,
  Grid,
  GridItem,
  Content,
  EmptyState,
  EmptyStateBody,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from "@patternfly/react-table";
import { fetchUsageStats } from "../api";
import type { UsageStats } from "../types";

const COLORS = ["#4a5568", "#3498db", "#27ae60", "#f39c12", "#9b59b6"];
const RANGE_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export function Usage() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("24h");

  const reload = (r: string) => {
    setLoading(true);
    fetchUsageStats(r)
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload(range);
    const interval = setInterval(() => reload(range), 30000);
    return () => clearInterval(interval);
  }, [range]);

  if (loading && !stats) {
    return (
      <PageSection>
        <Spinner />
      </PageSection>
    );
  }

  if (!stats || stats.total_requests === 0) {
    return (
      <PageSection>
        <Title headingLevel="h1" size="2xl" style={{ marginBottom: 16 }}>
          Usage
        </Title>
        <EmptyState titleText="No usage data" headingLevel="h2">
          <EmptyStateBody>
            No usage data found in Prometheus for the selected time range. Start using the models to generate data.
          </EmptyStateBody>
        </EmptyState>
      </PageSection>
    );
  }

  const kpiStyle = { textAlign: "center" as const, padding: "20px 16px" };
  const kpiValue = { fontSize: 28, fontWeight: 700, lineHeight: 1.2 };
  const kpiLabel = {
    fontSize: 11,
    color: "#6c757d",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginTop: 4,
  };

  const tierPieData = (stats.requests_by_tier || []).filter((d) => d.requests > 0);

  return (
    <PageSection>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div>
          <Title headingLevel="h1" size="2xl">
            Usage
          </Title>
          <Content component="p" style={{ color: "#6c757d", marginTop: 4 }}>
            Real-time metrics from Prometheus (auto-refreshes every 30s)
          </Content>
        </div>
        <ToggleGroup aria-label="Time range">
          {RANGE_OPTIONS.map((opt) => (
            <ToggleGroupItem
              key={opt.value}
              text={opt.label}
              buttonId={opt.value}
              isSelected={range === opt.value}
              onChange={() => setRange(opt.value)}
            />
          ))}
        </ToggleGroup>
      </div>

      {/* KPI row */}
      <Grid hasGutter style={{ marginTop: 16, marginBottom: 16 }}>
        <GridItem span={2}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#4a5568" }}>{stats.total_requests}</div>
              <div style={kpiLabel}>Requests</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={2}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#3498db" }}>{stats.total_tokens.toLocaleString()}</div>
              <div style={kpiLabel}>Total Tokens</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={2}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#27ae60" }}>{stats.total_prompt_tokens.toLocaleString()}</div>
              <div style={kpiLabel}>Prompt</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={2}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#f39c12" }}>{stats.total_completion_tokens.toLocaleString()}</div>
              <div style={kpiLabel}>Completion</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={2}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: "#9b59b6" }}>{stats.avg_latency}s</div>
              <div style={kpiLabel}>Avg Latency</div>
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={2}>
          <Card isCompact>
            <CardBody style={kpiStyle}>
              <div style={{ ...kpiValue, color: stats.rate_limited > 0 ? "#e74c3c" : "#27ae60" }}>
                {stats.rate_limited}
              </div>
              <div style={kpiLabel}>Rate Limited</div>
            </CardBody>
          </Card>
        </GridItem>
      </Grid>

      {/* Charts row */}
      <Grid hasGutter style={{ marginBottom: 16 }}>
        <GridItem span={6}>
          <Card isFullHeight>
            <CardTitle>Requests over time</CardTitle>
            <CardBody>
              {stats.requests_by_day.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={stats.requests_by_day}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="requests" fill="#4a5568" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No time series data</div>
              )}
            </CardBody>
          </Card>
        </GridItem>
        <GridItem span={6}>
          <Card isFullHeight>
            <CardTitle>Tokens over time</CardTitle>
            <CardBody>
              {stats.tokens_by_day.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={stats.tokens_by_day}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="prompt_tokens" stroke="#3498db" name="Prompt" strokeWidth={2} />
                    <Line type="monotone" dataKey="completion_tokens" stroke="#27ae60" name="Completion" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No time series data</div>
              )}
            </CardBody>
          </Card>
        </GridItem>
      </Grid>

      {/* By Model */}
      <Grid hasGutter style={{ marginBottom: 16 }}>
        <GridItem span={12}>
          <Card>
            <CardTitle>By Model (Prometheus)</CardTitle>
            <CardBody style={{ padding: 0 }}>
              <Table aria-label="Usage by model" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Model</Th>
                    <Th>Requests</Th>
                    <Th>Prompt Tokens</Th>
                    <Th>Completion Tokens</Th>
                    <Th>Users</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {stats.requests_by_model.map((r) => (
                    <Tr key={r.model}>
                      <Td>
                        <code style={{ fontSize: 11 }}>{r.model}</code>
                      </Td>
                      <Td>{r.requests}</Td>
                      <Td>{r.prompt_tokens.toLocaleString()}</Td>
                      <Td>{r.completion_tokens.toLocaleString()}</Td>
                      <Td>
                        {r.users && r.users.length > 0 ? (
                          r.users.map((u) => (
                            <div key={u.user} style={{ fontSize: 12, color: "#555" }}>
                              <strong>{u.user}</strong>
                              {" — "}
                              {u.requests} req, {u.prompt_tokens.toLocaleString()} prompt, {u.completion_tokens.toLocaleString()} compl.
                            </div>
                          ))
                        ) : (
                          <span style={{ fontSize: 12, color: "#999" }}>—</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </CardBody>
          </Card>
        </GridItem>
      </Grid>

      {/* By User */}
      {stats.requests_by_user && stats.requests_by_user.length > 0 && (
        <Grid hasGutter>
          <GridItem span={12}>
            <Card>
              <CardTitle>By User (session)</CardTitle>
              <CardBody style={{ padding: 0 }}>
                <Table aria-label="Usage by user" variant="compact">
                  <Thead>
                    <Tr>
                      <Th>User</Th>
                      <Th>Requests</Th>
                      <Th>Total Tokens</Th>
                      <Th>Model Breakdown</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {stats.requests_by_user.map((u) => (
                      <Tr key={u.user}>
                        <Td style={{ fontWeight: 600 }}>{u.user}</Td>
                        <Td>{u.requests}</Td>
                        <Td>{u.tokens.toLocaleString()}</Td>
                        <Td>
                          {u.models?.map((m) => (
                            <div key={m.model} style={{ fontSize: 12, color: "#555" }}>
                              <code style={{ fontSize: 11 }}>{m.model}</code>
                              {" — "}
                              {m.requests} req, {m.prompt_tokens.toLocaleString()} prompt, {m.completion_tokens.toLocaleString()} compl.
                            </div>
                          ))}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </CardBody>
            </Card>
          </GridItem>
        </Grid>
      )}
    </PageSection>
  );
}
