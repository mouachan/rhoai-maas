import { Label } from "@patternfly/react-core";

const TIER_COLORS: Record<string, "blue" | "orange" | "green" | "grey"> = {
  free: "grey",
  premium: "orange",
  enterprise: "green",
};

export function TierBadge({ tier }: { tier: string }) {
  const color = TIER_COLORS[tier] || "grey";
  return (
    <Label color={color} isCompact>
      {tier}
    </Label>
  );
}
