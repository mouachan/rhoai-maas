import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PageSection,
  Title,
  Spinner,
  EmptyState,
  EmptyStateBody,
  Content,
  SearchInput,
  FormSelect,
  FormSelectOption,
  Gallery,
  GalleryItem,
  Drawer,
  DrawerContent,
  DrawerContentBody,
  Flex,
  FlexItem,
} from "@patternfly/react-core";
import { useAuth } from "../AuthContext";
import { fetchModels } from "../api";
import { ModelCard } from "../components/ModelCard";
import { ModelDetailDrawer } from "../components/ModelDetailDrawer";
import type { EnrichedModel } from "../types";

const CATEGORY_OPTIONS = [
  { value: "", label: "All categories" },
  { value: "chat", label: "Chat" },
  { value: "embedding", label: "Embedding" },
  { value: "code", label: "Code" },
  { value: "vision", label: "Vision" },
];

export function Models() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [models, setModels] = useState<EnrichedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [detailModel, setDetailModel] = useState<EnrichedModel | null>(null);

  useEffect(() => {
    if (!session) return;
    fetchModels(session)
      .then((m) => {
        setModels(m);
        setLoading(false);
      })
      .catch(() => {
        setModels([]);
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

  const filtered = models.filter((m) => {
    const name = (m.catalog?.display_name || m.name || m.id).toLowerCase();
    const desc = (m.catalog?.description || "").toLowerCase();
    const matchesSearch = !search || name.includes(search.toLowerCase()) || desc.includes(search.toLowerCase());
    const matchesCategory = !category || (m.catalog?.category || "chat") === category;
    return matchesSearch && matchesCategory;
  });

  const drawerContent = (
    <PageSection>
      <div style={{ marginBottom: 16 }}>
        <Title headingLevel="h1" size="2xl">
          Models
        </Title>
        <Content component="p" style={{ color: "#6c757d", marginTop: 4 }}>
          {models.length} model{models.length !== 1 ? "s" : ""} available
        </Content>
      </div>

      {/* Filters */}
      <Flex gap={{ default: "gapMd" }} style={{ marginBottom: 16 }}>
        <FlexItem style={{ minWidth: 300, flex: 1, maxWidth: 400 }}>
          <SearchInput
            placeholder="Search models..."
            value={search}
            onChange={(_e, val) => setSearch(val)}
            onClear={() => setSearch("")}
          />
        </FlexItem>
        <FlexItem style={{ minWidth: 180 }}>
          <FormSelect
            value={category}
            onChange={(_e, val) => setCategory(val)}
            aria-label="Category filter"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <FormSelectOption key={opt.value} value={opt.value} label={opt.label} />
            ))}
          </FormSelect>
        </FlexItem>
      </Flex>

      {filtered.length === 0 ? (
        <EmptyState titleText="No models found" headingLevel="h2">
          <EmptyStateBody>
            {models.length === 0
              ? "No models are currently deployed. Contact your administrator."
              : "No models match your search criteria."}
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Gallery hasGutter minWidths={{ default: "320px" }}>
          {filtered.map((model) => (
            <GalleryItem key={model.id}>
              <ModelCard
                model={model}
                onTryPlayground={() =>
                  navigate(`/playground?model=${encodeURIComponent(model.id)}`)
                }
                onShowDetails={() => setDetailModel(model)}
              />
            </GalleryItem>
          ))}
        </Gallery>
      )}
    </PageSection>
  );

  return (
    <Drawer isExpanded={!!detailModel} onExpand={() => {}}>
      <DrawerContent
        panelContent={
          <ModelDetailDrawer
            model={detailModel}
            onClose={() => setDetailModel(null)}
          />
        }
      >
        <DrawerContentBody>{drawerContent}</DrawerContentBody>
      </DrawerContent>
    </Drawer>
  );
}
