import { useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Card,
  CardBody,
  Title,
  Button,
  TextInput,
  FormGroup,
  Alert,
  Content,
} from "@patternfly/react-core";
import { useAuth } from "../AuthContext";

export function LoginPage() {
  const { isAuthenticated, loading, error, login } = useAuth();
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (loading) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;

  const handleLogin = async () => {
    if (!token.trim()) return;
    setSubmitting(true);
    await login(token.trim());
    setSubmitting(false);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          background: "linear-gradient(135deg, #1b1f24, #2d333b)",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <img
          src="/logo.jpeg"
          alt="MaaS Portal"
          style={{ height: 36, marginRight: 10, borderRadius: 6 }}
        />
        <span style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, fontWeight: 500, letterSpacing: 0.5 }}>
          Models as a Service
        </span>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Card style={{ maxWidth: 440, width: "100%", margin: 20 }}>
          <CardBody>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <img
                src="/logo.jpeg"
                alt="MaaS Portal"
                style={{ height: 80, borderRadius: 12 }}
              />
            </div>
            <Title headingLevel="h2" style={{ textAlign: "center", marginBottom: 8 }}>
              Welcome to MaaS
            </Title>
            <Content
              component="p"
              style={{ textAlign: "center", color: "#6c757d", marginBottom: 24 }}
            >
              Enter your OpenShift token to access the platform
            </Content>

            {error && (
              <Alert
                variant="danger"
                title={error}
                isInline
                style={{ marginBottom: 16 }}
              />
            )}

            <FormGroup label="OpenShift Token" fieldId="ocp-token">
              <TextInput
                id="ocp-token"
                type="password"
                value={token}
                onChange={(_e, val) => setToken(val)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLogin();
                }}
                placeholder="sha256~xxxxxxxxxxxx"
              />
            </FormGroup>

            <Button
              variant="primary"
              isBlock
              onClick={handleLogin}
              isDisabled={submitting || !token.trim()}
              isLoading={submitting}
              style={{ marginTop: 16 }}
            >
              {submitting ? "Logging in..." : "Login"}
            </Button>

            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: "#f0f4f8",
                borderRadius: 8,
                fontSize: 12,
                color: "#6c757d",
              }}
            >
              <strong>How to get your token:</strong>
              <br />
              <code>oc whoami -t</code> after logging in with <code>oc login</code>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
