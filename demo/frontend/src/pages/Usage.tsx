import { useEffect, useState, useRef } from "react";
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
  Tabs,
  Tab,
  TabTitleText,
  Button,
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
import { useAuth } from "../AuthContext";
import { fetchUsageStats, fetchCostStats, fetchSloMetrics, getExportUrl } from "../api";
import type { UsageStats, CostStats, SloMetrics } from "../types";

const COLORS = ["#4a5568", "#3498db", "#27ae60", "#f39c12", "#9b59b6"];
const RANGE_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export function Usage() {
  const { isAdmin, session } = useAuth();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [costs, setCosts] = useState<CostStats | null>(null);
  const [slo, setSlo] = useState<SloMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("24h");
  const [activeTab, setActiveTab] = useState(0);
  const [sloModel, setSloModel] = useState("");
  const sloModelRef = useRef("");

  const reload = (r: string) => {
    setLoading(true);
    Promise.all([
      fetchUsageStats(r).catch(() => null),
      fetchCostStats(r).catch(() => null),
      isAdmin ? fetchSloMetrics(r, sloModelRef.current).catch(() => null) : Promise.resolve(null),
    ])
      .then(([s, c, sl]) => {
        setStats(s);
        setCosts(c);
        setSlo(sl);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload(range);
    const interval = setInterval(() => reload(range), 30000);
    return () => clearInterval(interval);
  }, [range]);

  const handleSloModelChange = (model: string) => {
    setSloModel(model);
    sloModelRef.current = model;
    fetchSloMetrics(range, model).catch(() => null).then(setSlo);
  };

  if (loading && !stats) {
    return (
      <PageSection>
        <Spinner />
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

  // Personal stats for non-admin (from filtered requests_by_user)
  const myUsage = stats?.requests_by_user?.[0] ?? null;
  const myCost = costs?.cost_by_user?.[0] ?? null;

  const tierPieData = (stats?.requests_by_tier || []).filter((d) => d.requests > 0);

  return (
    <PageSection>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div>
          <Title headingLevel="h1" size="2xl">
            {isAdmin ? "Usage (Platform)" : "My Usage"}
          </Title>
          <Content component="p" style={{ color: "#6c757d", marginTop: 4 }}>
            {isAdmin
              ? "Platform-wide metrics from Prometheus (auto-refreshes every 30s)"
              : `Personal usage for ${session?.username ?? "you"} (auto-refreshes every 30s)`}
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

      <Tabs activeKey={activeTab} onSelect={(_e, idx) => setActiveTab(idx as number)} style={{ marginTop: 8, marginBottom: 16 }}>
        <Tab eventKey={0} title={<TabTitleText>Usage</TabTitleText>}>
          {/* ==================== NON-ADMIN VIEW ==================== */}
          {!isAdmin && (
            <>
              {!myUsage ? (
                <EmptyState titleText="No usage data" headingLevel="h2" style={{ marginTop: 24 }}>
                  <EmptyStateBody>
                    You haven't made any requests yet. Start using models in the Playground.
                  </EmptyStateBody>
                </EmptyState>
              ) : (
                <>
                  {/* Personal KPIs */}
                  <Grid hasGutter style={{ marginTop: 16, marginBottom: 16 }}>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#4a5568" }}>{myUsage.requests}</div>
                          <div style={kpiLabel}>My Requests</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#3498db" }}>{myUsage.tokens.toLocaleString()}</div>
                          <div style={kpiLabel}>My Tokens</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#27ae60" }}>{myUsage.tier || "—"}</div>
                          <div style={kpiLabel}>Tier</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#e74c3c" }}>
                            ${myCost?.estimated_cost?.toFixed(4) ?? "0.00"}
                          </div>
                          <div style={kpiLabel}>Est. Cost</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>

                  {/* Tier limits */}
                  {session && (
                    <Card style={{ marginBottom: 16 }}>
                      <CardTitle>Tier Limits</CardTitle>
                      <CardBody>
                        <Grid hasGutter>
                          <GridItem span={6}>
                            <div style={{ fontSize: 13 }}>
                              <strong>Request Limit:</strong> {session.req_limit || "N/A"} per {session.req_window}
                            </div>
                            <div style={{ marginTop: 8 }}>
                              <div style={{ background: "#eee", borderRadius: 4, height: 20, overflow: "hidden" }}>
                                <div
                                  style={{
                                    background: session.req_limit && myUsage.requests / session.req_limit > 0.9 ? "#e74c3c" : "#27ae60",
                                    height: "100%",
                                    width: `${session.req_limit ? Math.min(100, (myUsage.requests / session.req_limit) * 100) : 0}%`,
                                    borderRadius: 4,
                                    transition: "width 0.3s",
                                  }}
                                />
                              </div>
                              <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
                                {myUsage.requests} / {session.req_limit || "—"}
                              </div>
                            </div>
                          </GridItem>
                          <GridItem span={6}>
                            <div style={{ fontSize: 13 }}>
                              <strong>Token Limit:</strong> {session.token_limit?.toLocaleString() || "N/A"} per {session.token_window}
                            </div>
                            <div style={{ marginTop: 8 }}>
                              <div style={{ background: "#eee", borderRadius: 4, height: 20, overflow: "hidden" }}>
                                <div
                                  style={{
                                    background: session.token_limit && myUsage.tokens / session.token_limit > 0.9 ? "#e74c3c" : "#3498db",
                                    height: "100%",
                                    width: `${session.token_limit ? Math.min(100, (myUsage.tokens / session.token_limit) * 100) : 0}%`,
                                    borderRadius: 4,
                                    transition: "width 0.3s",
                                  }}
                                />
                              </div>
                              <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
                                {myUsage.tokens.toLocaleString()} / {session.token_limit?.toLocaleString() || "—"}
                              </div>
                            </div>
                          </GridItem>
                        </Grid>
                      </CardBody>
                    </Card>
                  )}

                  {/* Personal model breakdown */}
                  {myUsage.models && myUsage.models.length > 0 && (
                    <Card style={{ marginBottom: 16 }}>
                      <CardTitle>My Model Usage</CardTitle>
                      <CardBody>
                        <Grid hasGutter>
                          <GridItem span={6}>
                            <ResponsiveContainer width="100%" height={200}>
                              <BarChart data={myUsage.models} layout="vertical">
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="model" width={150} tick={{ fontSize: 10 }} />
                                <Tooltip />
                                <Bar dataKey="requests" fill="#4a5568" name="Requests" radius={[0, 4, 4, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </GridItem>
                          <GridItem span={6}>
                            <Table aria-label="My model usage" variant="compact">
                              <Thead>
                                <Tr>
                                  <Th>Model</Th>
                                  <Th>Requests</Th>
                                  <Th>Prompt</Th>
                                  <Th>Completion</Th>
                                </Tr>
                              </Thead>
                              <Tbody>
                                {myUsage.models.map((m) => (
                                  <Tr key={m.model}>
                                    <Td><code style={{ fontSize: 10 }}>{m.model}</code></Td>
                                    <Td>{m.requests}</Td>
                                    <Td>{m.prompt_tokens.toLocaleString()}</Td>
                                    <Td>{m.completion_tokens.toLocaleString()}</Td>
                                  </Tr>
                                ))}
                              </Tbody>
                            </Table>
                          </GridItem>
                        </Grid>
                      </CardBody>
                    </Card>
                  )}

                  {/* Personal cost breakdown */}
                  {myCost && myCost.models && myCost.models.length > 0 && (
                    <Card>
                      <CardTitle>My Cost Breakdown</CardTitle>
                      <CardBody>
                        <Grid hasGutter>
                          <GridItem span={6}>
                            <ResponsiveContainer width="100%" height={200}>
                              <PieChart>
                                <Pie
                                  data={myCost.models}
                                  cx="50%"
                                  cy="50%"
                                  innerRadius={40}
                                  outerRadius={70}
                                  dataKey="estimated_cost"
                                  nameKey="model"
                                  label={({ model, percent }) => `${(model as string).slice(0, 15)}... ${(percent * 100).toFixed(0)}%`}
                                >
                                  {myCost.models.map((_, i) => (
                                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                                  ))}
                                </Pie>
                                <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]} />
                              </PieChart>
                            </ResponsiveContainer>
                          </GridItem>
                          <GridItem span={6}>
                            <Table aria-label="My cost breakdown" variant="compact">
                              <Thead>
                                <Tr>
                                  <Th>Model</Th>
                                  <Th>Tokens</Th>
                                  <Th>Est. Cost</Th>
                                </Tr>
                              </Thead>
                              <Tbody>
                                {myCost.models.map((m) => (
                                  <Tr key={m.model}>
                                    <Td><code style={{ fontSize: 10 }}>{m.model}</code></Td>
                                    <Td>{m.total_tokens.toLocaleString()}</Td>
                                    <Td style={{ color: "#e74c3c", fontWeight: 600 }}>${m.estimated_cost.toFixed(4)}</Td>
                                  </Tr>
                                ))}
                              </Tbody>
                            </Table>
                          </GridItem>
                        </Grid>
                      </CardBody>
                    </Card>
                  )}
                </>
              )}
            </>
          )}

          {/* ==================== ADMIN VIEW ==================== */}
          {isAdmin && (
            <>
              {!stats || stats.total_requests === 0 ? (
                <EmptyState titleText="No usage data" headingLevel="h2" style={{ marginTop: 24 }}>
                  <EmptyStateBody>
                    No usage data found in Prometheus for the selected time range.
                  </EmptyStateBody>
                </EmptyState>
              ) : (
                <>
                  {/* Platform KPIs */}
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

                  {/* Platform charts */}
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

                  {/* By Tier */}
                  {tierPieData.length > 0 && (
                    <Card style={{ marginBottom: 16 }}>
                      <CardTitle>By Tier</CardTitle>
                      <CardBody>
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart>
                            <Pie data={tierPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="requests" nameKey="tier" label>
                              {tierPieData.map((_, i) => (
                                <Cell key={i} fill={COLORS[i % COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip />
                            <Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      </CardBody>
                    </Card>
                  )}

                  {/* By Model */}
                  <Card style={{ marginBottom: 16 }}>
                    <CardTitle>By Model</CardTitle>
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
                              <Td><code style={{ fontSize: 11 }}>{r.model}</code></Td>
                              <Td>{r.requests}</Td>
                              <Td>{r.prompt_tokens.toLocaleString()}</Td>
                              <Td>{r.completion_tokens.toLocaleString()}</Td>
                              <Td>
                                {r.users && r.users.length > 0 ? (
                                  r.users.map((u) => (
                                    <div key={u.user} style={{ fontSize: 12, color: "#555" }}>
                                      <strong>{u.user}</strong>{" — "}{u.requests} req, {u.prompt_tokens.toLocaleString()} prompt, {u.completion_tokens.toLocaleString()} compl.
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

                  {/* By User */}
                  {stats.requests_by_user && stats.requests_by_user.length > 0 && (
                    <Card>
                      <CardTitle>By User</CardTitle>
                      <CardBody style={{ padding: 0 }}>
                        <Table aria-label="Usage by user" variant="compact">
                          <Thead>
                            <Tr>
                              <Th>User</Th>
                              <Th>Tier</Th>
                              <Th>Requests</Th>
                              <Th>Total Tokens</Th>
                              <Th>Model Breakdown</Th>
                            </Tr>
                          </Thead>
                          <Tbody>
                            {stats.requests_by_user.map((u) => (
                              <Tr key={u.user}>
                                <Td style={{ fontWeight: 600 }}>{u.user}</Td>
                                <Td>{u.tier || "—"}</Td>
                                <Td>{u.requests}</Td>
                                <Td>{u.tokens.toLocaleString()}</Td>
                                <Td>
                                  {u.models?.map((m) => (
                                    <div key={m.model} style={{ fontSize: 12, color: "#555" }}>
                                      <code style={{ fontSize: 11 }}>{m.model}</code>{" — "}{m.requests} req, {m.prompt_tokens.toLocaleString()} prompt, {m.completion_tokens.toLocaleString()} compl.
                                    </div>
                                  ))}
                                </Td>
                              </Tr>
                            ))}
                          </Tbody>
                        </Table>
                      </CardBody>
                    </Card>
                  )}
                </>
              )}
            </>
          )}
        </Tab>

        <Tab eventKey={1} title={<TabTitleText>Costs</TabTitleText>}>
          {/* ==================== NON-ADMIN COSTS ==================== */}
          {!isAdmin && (
            <>
              {!myCost ? (
                <EmptyState titleText="No cost data" headingLevel="h2" style={{ marginTop: 24 }}>
                  <EmptyStateBody>No usage data yet to calculate costs.</EmptyStateBody>
                </EmptyState>
              ) : (
                <>
                  <Grid hasGutter style={{ marginTop: 16, marginBottom: 16 }}>
                    <GridItem span={4}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#e74c3c" }}>${myCost.estimated_cost.toFixed(4)}</div>
                          <div style={kpiLabel}>My Total Cost</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={4}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#3498db" }}>{myCost.total_tokens.toLocaleString()}</div>
                          <div style={kpiLabel}>My Total Tokens</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={4}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#27ae60" }}>{myCost.tier}</div>
                          <div style={kpiLabel}>Tier</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>

                  {myCost.models && myCost.models.length > 0 && (
                    <Card>
                      <CardTitle>My Cost by Model</CardTitle>
                      <CardBody>
                        <Grid hasGutter>
                          <GridItem span={6}>
                            <ResponsiveContainer width="100%" height={200}>
                              <PieChart>
                                <Pie
                                  data={myCost.models}
                                  cx="50%"
                                  cy="50%"
                                  innerRadius={40}
                                  outerRadius={70}
                                  dataKey="estimated_cost"
                                  nameKey="model"
                                  label={({ model, percent }) => `${(model as string).slice(0, 15)}... ${(percent * 100).toFixed(0)}%`}
                                >
                                  {myCost.models.map((_, i) => (
                                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                                  ))}
                                </Pie>
                                <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]} />
                              </PieChart>
                            </ResponsiveContainer>
                          </GridItem>
                          <GridItem span={6}>
                            <Table aria-label="My cost by model" variant="compact">
                              <Thead>
                                <Tr>
                                  <Th>Model</Th>
                                  <Th>Tokens</Th>
                                  <Th>Est. Cost</Th>
                                </Tr>
                              </Thead>
                              <Tbody>
                                {myCost.models.map((m) => (
                                  <Tr key={m.model}>
                                    <Td><code style={{ fontSize: 10 }}>{m.model}</code></Td>
                                    <Td>{m.total_tokens.toLocaleString()}</Td>
                                    <Td style={{ color: "#e74c3c", fontWeight: 600 }}>${m.estimated_cost.toFixed(4)}</Td>
                                  </Tr>
                                ))}
                              </Tbody>
                            </Table>
                          </GridItem>
                        </Grid>
                      </CardBody>
                    </Card>
                  )}
                </>
              )}
            </>
          )}

          {/* ==================== ADMIN COSTS ==================== */}
          {isAdmin && (
            <>
              {!costs || costs.total_cost === 0 ? (
                <EmptyState titleText="No cost data" headingLevel="h2" style={{ marginTop: 24 }}>
                  <EmptyStateBody>No usage data to calculate costs.</EmptyStateBody>
                </EmptyState>
              ) : (
                <>
                  <Grid hasGutter style={{ marginTop: 16, marginBottom: 16 }}>
                    <GridItem span={4}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#e74c3c" }}>${costs.total_cost.toFixed(2)}</div>
                          <div style={kpiLabel}>Total Cost</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={4}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#f39c12" }}>
                            ${costs.cost_by_user.length > 0 ? (costs.total_cost / costs.cost_by_user.length).toFixed(2) : "0.00"}
                          </div>
                          <div style={kpiLabel}>Cost / User (avg)</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={4}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#9b59b6" }}>
                            ${costs.cost_by_model.length > 0 ? (costs.total_cost / costs.cost_by_model.length).toFixed(2) : "0.00"}
                          </div>
                          <div style={kpiLabel}>Cost / Model (avg)</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>

                  <Grid hasGutter style={{ marginBottom: 16 }}>
                    <GridItem span={6}>
                      <Card isFullHeight>
                        <CardTitle>Cost over time</CardTitle>
                        <CardBody>
                          {costs.cost_over_time.length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                              <LineChart data={costs.cost_over_time}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                                <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]} />
                                <Line type="monotone" dataKey="estimated_cost" stroke="#e74c3c" name="Cost" strokeWidth={2} />
                              </LineChart>
                            </ResponsiveContainer>
                          ) : (
                            <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No time series data</div>
                          )}
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={6}>
                      <Card isFullHeight>
                        <CardTitle>Cost by Model</CardTitle>
                        <CardBody>
                          {costs.cost_by_model.length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                              <PieChart>
                                <Pie
                                  data={costs.cost_by_model}
                                  cx="50%"
                                  cy="50%"
                                  innerRadius={40}
                                  outerRadius={80}
                                  dataKey="estimated_cost"
                                  nameKey="model"
                                  label={({ model, percent }) => `${(model as string).slice(0, 15)}... ${(percent * 100).toFixed(0)}%`}
                                >
                                  {costs.cost_by_model.map((_, i) => (
                                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                                  ))}
                                </Pie>
                                <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]} />
                              </PieChart>
                            </ResponsiveContainer>
                          ) : (
                            <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No data</div>
                          )}
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>

                  {costs.cost_by_user.length > 0 && (
                    <Card style={{ marginBottom: 16 }}>
                      <CardTitle>Cost by User</CardTitle>
                      <CardBody>
                        <ResponsiveContainer width="100%" height={Math.max(200, costs.cost_by_user.length * 40)}>
                          <BarChart data={costs.cost_by_user} layout="vertical">
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" tickFormatter={(v) => `$${v}`} />
                            <YAxis type="category" dataKey="user" width={150} tick={{ fontSize: 11 }} />
                            <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]} />
                            <Bar dataKey="estimated_cost" fill="#e74c3c" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </CardBody>
                    </Card>
                  )}

                  <Card style={{ marginBottom: 16 }}>
                    <CardTitle>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Cost Details</span>
                        <Button variant="secondary" size="sm" onClick={() => window.open(getExportUrl(range), "_blank")}>
                          Download CSV
                        </Button>
                      </div>
                    </CardTitle>
                    <CardBody style={{ padding: 0 }}>
                      <Table aria-label="Cost details" variant="compact">
                        <Thead>
                          <Tr>
                            <Th>User</Th>
                            <Th>Tier</Th>
                            <Th>Total Tokens</Th>
                            <Th>Est. Cost</Th>
                            <Th>Model Breakdown</Th>
                          </Tr>
                        </Thead>
                        <Tbody>
                          {costs.cost_by_user.map((u) => (
                            <Tr key={u.user}>
                              <Td style={{ fontWeight: 600 }}>{u.user}</Td>
                              <Td>{u.tier}</Td>
                              <Td>{u.total_tokens.toLocaleString()}</Td>
                              <Td style={{ color: "#e74c3c", fontWeight: 600 }}>${u.estimated_cost.toFixed(4)}</Td>
                              <Td>
                                {u.models.map((m) => (
                                  <div key={m.model} style={{ fontSize: 12, color: "#555" }}>
                                    <code style={{ fontSize: 11 }}>{m.model}</code>{" — "}{m.total_tokens.toLocaleString()} tokens, ${m.estimated_cost.toFixed(4)}
                                  </div>
                                ))}
                              </Td>
                            </Tr>
                          ))}
                        </Tbody>
                      </Table>
                    </CardBody>
                  </Card>
                </>
              )}
            </>
          )}
        </Tab>

        {isAdmin && (
        <Tab eventKey={2} title={<TabTitleText>SLO</TabTitleText>}>
          {!slo ? (
            <EmptyState titleText="No SLO data" headingLevel="h2" style={{ marginTop: 24 }}>
              <EmptyStateBody>No SLO metrics available for the selected time range.</EmptyStateBody>
            </EmptyState>
          ) : (
            <>
              {/* Model selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 8 }}>
                <label htmlFor="slo-model-select" style={{ fontSize: 13, fontWeight: 600 }}>Model:</label>
                <select
                  id="slo-model-select"
                  value={sloModel}
                  onChange={(e) => handleSloModelChange(e.target.value)}
                  style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #ccc", fontSize: 13 }}
                >
                  <option value="">All models</option>
                  {(stats?.requests_by_model || []).map((m) => (
                    <option key={m.model} value={m.model}>{m.model}</option>
                  ))}
                </select>
              </div>

              {/* ===== LATENCY + TTFT + TPOT GAUGES ===== */}
              <Grid hasGutter style={{ marginTop: 8, marginBottom: 16 }}>
                <GridItem span={4}>
                  <Card isCompact>
                    <CardTitle style={{ fontSize: 13, textAlign: "center" }}>E2E Latency</CardTitle>
                    <CardBody style={{ textAlign: "center", paddingTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-around" }}>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#27ae60" }}>{slo.latency.p50}s</div>
                          <div style={kpiLabel}>P50</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#f39c12" }}>{slo.latency.p95}s</div>
                          <div style={kpiLabel}>P95</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#e74c3c" }}>{slo.latency.p99}s</div>
                          <div style={kpiLabel}>P99</div>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </GridItem>
                <GridItem span={4}>
                  <Card isCompact>
                    <CardTitle style={{ fontSize: 13, textAlign: "center" }}>Time to First Token</CardTitle>
                    <CardBody style={{ textAlign: "center", paddingTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-around" }}>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#27ae60" }}>{slo.ttft.p50}s</div>
                          <div style={kpiLabel}>P50</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#f39c12" }}>{slo.ttft.p95}s</div>
                          <div style={kpiLabel}>P95</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#e74c3c" }}>{slo.ttft.p99}s</div>
                          <div style={kpiLabel}>P99</div>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </GridItem>
                <GridItem span={4}>
                  <Card isCompact>
                    <CardTitle style={{ fontSize: 13, textAlign: "center" }}>Performance</CardTitle>
                    <CardBody style={{ textAlign: "center", paddingTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-around" }}>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#9b59b6" }}>{slo.tpot_p95}s</div>
                          <div style={kpiLabel}>TPOT P95</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#3498db" }}>{slo.throughput_rps}</div>
                          <div style={kpiLabel}>req/s</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: slo.error_rate > 0.05 ? "#e74c3c" : "#27ae60" }}>
                            {(slo.error_rate * 100).toFixed(2)}%
                          </div>
                          <div style={kpiLabel}>Error Rate</div>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </GridItem>
              </Grid>

              {/* ===== Advanced SLO metrics ===== */}
              {slo.token_throughput && (
                <>
                  {/* Throughput + Infrastructure gauges */}
                  <Grid hasGutter style={{ marginBottom: 16 }}>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#3498db", fontSize: 22 }}>{slo.token_throughput.total_tps}</div>
                          <div style={kpiLabel}>Tokens/s (total)</div>
                          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
                            Prompt: {slo.token_throughput.prompt_tps} | Completion: {slo.token_throughput.completion_tps}
                          </div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: "#f39c12", fontSize: 22 }}>{slo.queue_time_p95 ?? 0}s</div>
                          <div style={kpiLabel}>Queue Wait P95</div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
                            <div>
                              <div style={{ fontSize: 22, fontWeight: 700, color: "#27ae60" }}>{slo.running_requests ?? 0}</div>
                              <div style={kpiLabel}>Running</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 22, fontWeight: 700, color: "#e74c3c" }}>{slo.waiting_requests ?? 0}</div>
                              <div style={kpiLabel}>Waiting</div>
                            </div>
                          </div>
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={3}>
                      <Card isCompact>
                        <CardBody style={kpiStyle}>
                          <div style={{ ...kpiValue, color: (slo.kv_cache_pct ?? 0) > 80 ? "#e74c3c" : "#27ae60", fontSize: 22 }}>
                            {slo.kv_cache_pct ?? 0}%
                          </div>
                          <div style={kpiLabel}>KV Cache Usage</div>
                          <div style={{ marginTop: 6 }}>
                            <div style={{ background: "#eee", borderRadius: 4, height: 8, overflow: "hidden" }}>
                              <div style={{
                                background: (slo.kv_cache_pct ?? 0) > 80 ? "#e74c3c" : "#27ae60",
                                height: "100%",
                                width: `${Math.min(100, slo.kv_cache_pct ?? 0)}%`,
                                borderRadius: 4,
                              }} />
                            </div>
                          </div>
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>

                  {/* Latency over time (P50/P95/P99) */}
                  <Grid hasGutter style={{ marginBottom: 16 }}>
                    <GridItem span={6}>
                      <Card isFullHeight>
                        <CardTitle>E2E Latency over time</CardTitle>
                        <CardBody>
                          {slo.latency_over_time && slo.latency_over_time.length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                              <LineChart data={slo.latency_over_time}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                <YAxis tick={{ fontSize: 11 }} unit="s" />
                                <Tooltip formatter={(v: number) => [`${v}s`]} />
                                <Legend />
                                <Line type="monotone" dataKey="p50" stroke="#27ae60" name="P50" strokeWidth={2} dot={false} />
                                <Line type="monotone" dataKey="p95" stroke="#f39c12" name="P95" strokeWidth={2} dot={false} />
                                <Line type="monotone" dataKey="p99" stroke="#e74c3c" name="P99" strokeWidth={2} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          ) : (
                            <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No time series data</div>
                          )}
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={6}>
                      <Card isFullHeight>
                        <CardTitle>TTFT P95 over time</CardTitle>
                        <CardBody>
                          {slo.ttft_over_time && slo.ttft_over_time.length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                              <LineChart data={slo.ttft_over_time}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                <YAxis tick={{ fontSize: 11 }} unit="s" />
                                <Tooltip formatter={(v: number) => [`${v}s`]} />
                                <Line type="monotone" dataKey="ttft_p95" stroke="#9b59b6" name="TTFT P95" strokeWidth={2} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          ) : (
                            <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No time series data</div>
                          )}
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>

                  {/* Throughput over time + Error breakdown */}
                  <Grid hasGutter style={{ marginBottom: 16 }}>
                    <GridItem span={6}>
                      <Card isFullHeight>
                        <CardTitle>Throughput over time</CardTitle>
                        <CardBody>
                          {slo.throughput_over_time && slo.throughput_over_time.length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                              <LineChart data={slo.throughput_over_time}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                <YAxis tick={{ fontSize: 11 }} unit=" r/s" />
                                <Tooltip formatter={(v: number) => [`${v} req/s`]} />
                                <Line type="monotone" dataKey="rps" stroke="#3498db" name="Req/s" strokeWidth={2} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          ) : (
                            <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No time series data</div>
                          )}
                        </CardBody>
                      </Card>
                    </GridItem>
                    <GridItem span={6}>
                      <Card isFullHeight>
                        <CardTitle>Request Outcome Breakdown</CardTitle>
                        <CardBody>
                          {slo.error_breakdown && slo.error_breakdown.filter((e) => e.count > 0).length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                              <PieChart>
                                <Pie
                                  data={slo.error_breakdown.filter((e) => e.count > 0)}
                                  cx="50%"
                                  cy="50%"
                                  innerRadius={40}
                                  outerRadius={80}
                                  dataKey="count"
                                  nameKey="reason"
                                  label={({ reason, percent }) => `${reason} ${(percent * 100).toFixed(0)}%`}
                                >
                                  {slo.error_breakdown.filter((e) => e.count > 0).map((_, i) => (
                                    <Cell key={i} fill={["#27ae60", "#f39c12", "#e74c3c", "#c0392b"][i % 4]} />
                                  ))}
                                </Pie>
                                <Tooltip />
                                <Legend />
                              </PieChart>
                            </ResponsiveContainer>
                          ) : (
                            <div style={{ textAlign: "center", color: "#999", paddingTop: 80 }}>No error data</div>
                          )}
                        </CardBody>
                      </Card>
                    </GridItem>
                  </Grid>
                </>
              )}
            </>
          )}
        </Tab>
        )}
      </Tabs>
    </PageSection>
  );
}
