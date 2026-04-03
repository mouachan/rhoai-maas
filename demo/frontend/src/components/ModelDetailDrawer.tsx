import { useEffect, useState } from "react";
import {
  DrawerPanelContent,
  DrawerHead,
  DrawerActions,
  DrawerCloseButton,
  DrawerPanelBody,
  Title,
  Label,
  Content,
  Button,
  Spinner,
  Flex,
  FlexItem,
  Grid,
  GridItem,
  Card,
  CardBody,
} from "@patternfly/react-core";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchModelStatus } from "../api";
import type { EnrichedModel, ModelStatus } from "../types";

interface ModelDetailDrawerProps {
  model: EnrichedModel | null;
  onClose: () => void;
}

export function ModelDetailDrawer({ model, onClose }: ModelDetailDrawerProps) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  useEffect(() => {
    if (!model) return;
    setLoadingStatus(true);
    setStatus(null);
    fetchModelStatus(model.id)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoadingStatus(false));
  }, [model?.id]);

  if (!model) return null;

  const catalog = model.catalog;
  const displayName = catalog?.display_name || model.name || model.id;

  const latencyData = status
    ? [
        { name: "P50", value: status.latency_p50 },
        { name: "P95", value: status.latency_p95 },
        { name: "P99", value: status.latency_p99 },
      ]
    : [];

  const kpiStyle = { textAlign: "center" as const, padding: "12px 8px" };
  const kpiValue = { fontSize: 20, fontWeight: 700, lineHeight: 1.2 };
  const kpiLabel = {
    fontSize: 10,
    color: "#6c757d",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginTop: 2,
  };

  return (
    <DrawerPanelContent widths={{ default: "width_50" }}>
      <DrawerHead>
        <Title headingLevel="h2" size="xl">
          {displayName}
        </Title>
        <DrawerActions>
          <DrawerCloseButton onClick={onClose} />
        </DrawerActions>
      </DrawerHead>
      <DrawerPanelBody>
        {/* Basic info */}
        <div style={{ marginBottom: 16 }}>
          <Content component="small" style={{ color: "#999" }}>
            ID: {model.id}
          </Content>
        </div>

        {catalog && (
          <>
            <Content component="p" style={{ marginBottom: 16 }}>
              {catalog.description}
            </Content>

            <Flex gap={{ default: "gapSm" }} style={{ marginBottom: 16 }}>
              <FlexItem>
                <Label color="blue" isCompact>
                  {catalog.category}
                </Label>
              </FlexItem>
              {catalog.tags?.map((tag) => (
                <FlexItem key={tag}>
                  <Label isCompact>{tag}</Label>
                </FlexItem>
              ))}
            </Flex>

            <div style={{ fontSize: 13, marginBottom: 16 }}>
              <div style={{ marginBottom: 4 }}>
                <strong>Provider:</strong> {catalog.provider}
              </div>
              <div style={{ marginBottom: 4 }}>
                <strong>Context Window:</strong> {catalog.context_window?.toLocaleString()} tokens
              </div>
              <div style={{ marginBottom: 4 }}>
                <strong>Pricing:</strong> ${catalog.cost_per_1k_prompt_tokens}/1K prompt, ${catalog.cost_per_1k_completion_tokens}/1K completion
              </div>
              {catalog.documentation_url && (
                <div>
                  <Button
                    variant="link"
                    component="a"
                    href={catalog.documentation_url}
                    target="_blank"
                    style={{ paddingLeft: 0 }}
                  >
                    Documentation
                  </Button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Live metrics */}
        <Title headingLevel="h3" size="lg" style={{ marginBottom: 12 }}>
          Live Metrics
        </Title>

        {loadingStatus ? (
          <Spinner size="md" />
        ) : status ? (
          <>
            <Grid hasGutter style={{ marginBottom: 16 }}>
              <GridItem span={4}>
                <Card isCompact>
                  <CardBody style={kpiStyle}>
                    <div style={{
                      ...kpiValue,
                      color: status.availability === "up" ? "#27ae60" : status.availability === "degraded" ? "#f39c12" : "#e74c3c",
                    }}>
                      {status.availability.toUpperCase()}
                    </div>
                    <div style={kpiLabel}>Status</div>
                  </CardBody>
                </Card>
              </GridItem>
              <GridItem span={4}>
                <Card isCompact>
                  <CardBody style={kpiStyle}>
                    <div style={{ ...kpiValue, color: "#3498db" }}>{status.throughput_rps}</div>
                    <div style={kpiLabel}>RPS</div>
                  </CardBody>
                </Card>
              </GridItem>
              <GridItem span={4}>
                <Card isCompact>
                  <CardBody style={kpiStyle}>
                    <div style={{ ...kpiValue, color: "#f39c12" }}>{(status.error_rate * 100).toFixed(1)}%</div>
                    <div style={kpiLabel}>Error Rate</div>
                  </CardBody>
                </Card>
              </GridItem>
            </Grid>

            {latencyData.length > 0 && (
              <Card isCompact style={{ marginBottom: 16 }}>
                <CardBody>
                  <Content component="small" style={{ fontWeight: 600 }}>
                    Latency (seconds)
                  </Content>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={latencyData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#4a5568" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardBody>
              </Card>
            )}
          </>
        ) : (
          <Content component="p" style={{ color: "#999" }}>
            No live metrics available for this model.
          </Content>
        )}
      </DrawerPanelBody>
    </DrawerPanelContent>
  );
}
