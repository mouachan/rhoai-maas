import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PageSection,
  Title,
  Spinner,
  EmptyState,
  EmptyStateBody,
  Card,
  CardBody,
  Button,
  ClipboardCopy,
  Content,
} from "@patternfly/react-core";
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
  ActionsColumn,
} from "@patternfly/react-table";
import { useAuth } from "../AuthContext";
import { fetchModels, fetchConfig } from "../api";
import type { MaaSModel, AppConfig } from "../types";

export function Models() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [models, setModels] = useState<MaaSModel[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      fetchModels(session).catch(() => []),
      fetchConfig().catch(() => null),
    ]).then(([m, c]) => {
      setModels(m);
      setConfig(c);
      setLoading(false);
    });
  }, [session]);

  if (loading) {
    return (
      <PageSection>
        <Spinner />
      </PageSection>
    );
  }

  const gatewayUrl = config?.gateway_url || "";

  return (
    <PageSection>
      <div style={{ marginBottom: 16 }}>
        <Title headingLevel="h1" size="2xl">
          Models
        </Title>
        <Content component="p" style={{ color: "#6c757d", marginTop: 4 }}>
          {models.length} model{models.length !== 1 ? "s" : ""} available on this platform
        </Content>
      </div>

      {models.length === 0 ? (
        <EmptyState titleText="No models available" headingLevel="h2">
          <EmptyStateBody>
            No models are currently deployed. Contact your administrator.
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Card>
          <CardBody style={{ padding: 0 }}>
            <Table aria-label="Models table" variant="compact">
              <Thead>
                <Tr>
                  <Th>Model Name</Th>
                  <Th>Endpoint URL</Th>
                  <Th>Tiers</Th>
                  <Th screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {models.map((model) => (
                  <Tr key={model.id}>
                    <Td dataLabel="Model Name">
                      <div style={{ fontWeight: 600 }}>{model.name || model.id}</div>
                      <div style={{ fontSize: 11, color: "#999" }}>ID: {model.id}</div>
                    </Td>
                    <Td dataLabel="Endpoint URL">
                      <ClipboardCopy
                        isReadOnly
                        hoverTip="Copy"
                        clickTip="Copied"
                        variant="inline-compact"
                      >
                        {gatewayUrl}/{model.endpoint || `${model.id}/v1/chat/completions`}
                      </ClipboardCopy>
                    </Td>
                    <Td dataLabel="Tiers">
                      {model.tiers?.join(", ") || "all"}
                    </Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          {
                            title: "Try in Playground",
                            onClick: () =>
                              navigate(`/playground?model=${encodeURIComponent(model.id)}`),
                          },
                        ]}
                      />
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </PageSection>
  );
}
