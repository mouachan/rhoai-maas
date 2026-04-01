import { useEffect, useState } from "react";
import {
  PageSection,
  Title,
  Spinner,
  EmptyState,
  EmptyStateBody,
  Button,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  FormGroup,
  TextInput,
  FormSelect,
  FormSelectOption,
  ClipboardCopy,
  Alert,
  Card,
  CardBody,
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
import { fetchKeys, createKey, deleteKey } from "../api";
import type { ApiKey } from "../types";

const EXPIRATION_OPTIONS = [
  { value: "", label: "No expiration" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "168h", label: "7 days" },
  { value: "720h", label: "30 days" },
  { value: "2160h", label: "90 days" },
];

export function ApiKeys() {
  const { session } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiNotAvailable, setApiNotAvailable] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyExpiration, setKeyExpiration] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);

  const loadKeys = () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    fetchKeys(session)
      .then(setKeys)
      .catch((e) => {
        const msg = String(e);
        if (msg.includes("404") || msg.includes("405")) {
          setApiNotAvailable(true);
        } else {
          setError(msg);
        }
        setKeys([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadKeys();
  }, [session]);

  const handleCreate = async () => {
    if (!session) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createKey(session, keyName || undefined, keyExpiration || undefined);
      setCreatedKey(result.key || result.id || JSON.stringify(result));
      loadKeys();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!session || !deleteTarget) return;
    try {
      await deleteKey(session, deleteTarget.id);
      loadKeys();
    } catch (e) {
      setError(String(e));
    }
    setDeleteTarget(null);
  };

  if (loading) {
    return (
      <PageSection>
        <Spinner />
      </PageSection>
    );
  }

  return (
    <PageSection>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <Title headingLevel="h1" size="2xl">
            API Keys
          </Title>
          <Content component="p" style={{ color: "#6c757d", marginTop: 4 }}>
            Create and manage API keys for programmatic access
          </Content>
        </div>
        {!apiNotAvailable && (
          <Button
            variant="primary"
            onClick={() => {
              setKeyName("");
              setKeyExpiration("");
              setCreatedKey(null);
              setError(null);
              setShowCreate(true);
            }}
          >
            Create API Key
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="warning" title={error} isInline style={{ marginBottom: 16 }} />
      )}

      {apiNotAvailable ? (
        <EmptyState titleText="API Keys not available" headingLevel="h2">
          <EmptyStateBody>
            The API Keys feature is not available on this RHOAI version.
            API key management requires RHOAI 3.4 or later.
          </EmptyStateBody>
        </EmptyState>
      ) : keys.length === 0 ? (
        <EmptyState titleText="No API keys" headingLevel="h2">
          <EmptyStateBody>
            Create your first API key to access models programmatically.
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Card>
          <CardBody style={{ padding: 0 }}>
            <Table aria-label="API Keys table" variant="compact">
              <Thead>
                <Tr>
                  <Th>Key ID</Th>
                  <Th>Name</Th>
                  <Th>Created</Th>
                  <Th>Expires</Th>
                  <Th screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {keys.map((k) => (
                  <Tr key={k.id}>
                    <Td dataLabel="Key ID">
                      <code style={{ fontSize: 12 }}>{k.id}</code>
                    </Td>
                    <Td dataLabel="Name">{k.name || "-"}</Td>
                    <Td dataLabel="Created">
                      {k.created_at ? new Date(k.created_at).toLocaleDateString() : "-"}
                    </Td>
                    <Td dataLabel="Expires">
                      {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "Never"}
                    </Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          {
                            title: "Revoke",
                            onClick: () => setDeleteTarget(k),
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

      {/* Create Key Modal */}
      <Modal variant={ModalVariant.small} isOpen={showCreate} onClose={() => setShowCreate(false)}>
        <ModalHeader title={createdKey ? "API Key Created" : "Create API Key"} />
        <ModalBody>
          {createdKey ? (
            <div>
              <Alert variant="info" title="Save your key" isInline style={{ marginBottom: 12 }}>
                Copy your API key now. You will not be able to see it again.
              </Alert>
              <ClipboardCopy isReadOnly hoverTip="Copy" clickTip="Copied">
                {createdKey}
              </ClipboardCopy>
            </div>
          ) : (
            <>
              <FormGroup label="Key Name" fieldId="key-name">
                <TextInput
                  id="key-name"
                  value={keyName}
                  onChange={(_e, val) => setKeyName(val)}
                  placeholder="my-app-key"
                />
              </FormGroup>
              <FormGroup label="Expiration" fieldId="key-expiration" style={{ marginTop: 12 }}>
                <FormSelect
                  id="key-expiration"
                  value={keyExpiration}
                  onChange={(_e, val) => setKeyExpiration(val)}
                >
                  {EXPIRATION_OPTIONS.map((opt) => (
                    <FormSelectOption key={opt.value} value={opt.value} label={opt.label} />
                  ))}
                </FormSelect>
              </FormGroup>
              {error && (
                <Alert variant="danger" title={error} isInline style={{ marginTop: 12 }} />
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          {createdKey ? (
            <Button variant="primary" onClick={() => setShowCreate(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="primary" onClick={handleCreate} isDisabled={creating} isLoading={creating}>
                Create
              </Button>
              <Button variant="link" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </>
          )}
        </ModalFooter>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal variant={ModalVariant.small} isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <ModalHeader title="Revoke API Key" />
        <ModalBody>
          Are you sure you want to revoke key{" "}
          <strong>{deleteTarget?.name || deleteTarget?.id}</strong>? This cannot be undone.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={handleDelete}>
            Revoke
          </Button>
          <Button variant="link" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
