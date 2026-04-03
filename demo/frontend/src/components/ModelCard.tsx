import {
  Card,
  CardTitle,
  CardBody,
  CardFooter,
  Button,
  Label,
  Content,
  Flex,
  FlexItem,
} from "@patternfly/react-core";
import type { EnrichedModel } from "../types";

const CATEGORY_COLORS: Record<string, "blue" | "green" | "purple" | "orange" | "grey"> = {
  chat: "blue",
  embedding: "green",
  code: "purple",
  vision: "orange",
};

const STATUS_COLORS: Record<string, string> = {
  up: "#27ae60",
  degraded: "#f39c12",
  down: "#e74c3c",
};

interface ModelCardProps {
  model: EnrichedModel;
  onTryPlayground: () => void;
  onShowDetails: () => void;
}

export function ModelCard({
  model,
  onTryPlayground,
  onShowDetails,
}: ModelCardProps) {
  const catalog = model.catalog;
  const category = catalog?.category || "chat";
  const displayName = catalog?.display_name || model.name || model.id;
  const description = catalog?.description || "";
  const truncatedDesc = description.length > 120 ? description.slice(0, 120) + "..." : description;

  return (
    <Card isClickable isCompact style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <CardTitle>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
          <FlexItem>
            <span
              style={{ cursor: "pointer", fontWeight: 600 }}
              onClick={onShowDetails}
            >
              {displayName}
            </span>
          </FlexItem>
          <FlexItem>
            <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
              {model.status && (
                <FlexItem>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: STATUS_COLORS[model.status.availability] || "#999",
                    }}
                    title={model.status.availability}
                  />
                </FlexItem>
              )}
              <FlexItem>
                <Label color={CATEGORY_COLORS[category] || "grey"} isCompact>
                  {category}
                </Label>
              </FlexItem>
            </Flex>
          </FlexItem>
        </Flex>
      </CardTitle>
      <CardBody style={{ flex: 1 }}>
        {truncatedDesc && (
          <Content component="p" style={{ fontSize: 13, color: "#555", marginBottom: 12 }}>
            {truncatedDesc}
          </Content>
        )}
        <div style={{ fontSize: 12, color: "#666" }}>
          {catalog?.provider && (
            <div style={{ marginBottom: 4 }}>
              <strong>Provider:</strong> {catalog.provider}
            </div>
          )}
          {catalog && (catalog.cost_per_1k_prompt_tokens > 0 || catalog.cost_per_1k_completion_tokens > 0) && (
            <div style={{ marginBottom: 4 }}>
              <strong>Pricing:</strong>{" "}
              ${catalog.cost_per_1k_prompt_tokens}/1K prompt, ${catalog.cost_per_1k_completion_tokens}/1K completion
            </div>
          )}
          {model.tiers && model.tiers.length > 0 && (
            <div>
              {model.tiers.map((t) => (
                <Label key={t} isCompact style={{ marginRight: 4 }}>
                  {t}
                </Label>
              ))}
            </div>
          )}
        </div>
      </CardBody>
      <CardFooter>
        <Flex gap={{ default: "gapSm" }}>
          <FlexItem>
            <Button variant="primary" size="sm" onClick={onTryPlayground}>
              Try in Playground
            </Button>
          </FlexItem>
          <FlexItem>
            <Button variant="link" size="sm" onClick={onShowDetails}>
              Details
            </Button>
          </FlexItem>
        </Flex>
      </CardFooter>
    </Card>
  );
}
