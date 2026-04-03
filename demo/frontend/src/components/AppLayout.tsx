import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Page,
  Masthead,
  MastheadMain,
  MastheadBrand,
  MastheadContent,
  PageSidebar,
  PageSidebarBody,
  Nav,
  NavItem,
  NavList,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarGroup,
  Button,
  Label,
} from "@patternfly/react-core";
import { UserIcon, PowerOffIcon } from "@patternfly/react-icons";
import { useAuth } from "../AuthContext";
import { TierBadge } from "./TierBadge";

const NAV_ITEMS = [
  { path: "/", label: "Dashboard" },
  { path: "/models", label: "Models" },
  { path: "/api-keys", label: "API Keys" },
  { path: "/playground", label: "Playground" },
  { path: "/usage", label: "Usage" },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const masthead = (
    <Masthead
      style={{
        background: "linear-gradient(135deg, #1b1f24, #2d333b)",
      }}
    >
      <MastheadMain>
        <MastheadBrand>
          <span style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, fontWeight: 500, letterSpacing: 0.5 }}>
            Models as a Service
          </span>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight>
          <ToolbarContent>
            <ToolbarGroup align={{ default: "alignEnd" }}>
              {session && (
                <>
                  <ToolbarItem>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <UserIcon style={{ color: "rgba(255,255,255,0.7)", fontSize: 14 }} />
                      <span style={{ color: "#fff", fontSize: 13, fontWeight: 500 }}>
                        {session.username}
                      </span>
                      {isAdmin && <Label color="purple" isCompact>Admin</Label>}
                      <TierBadge tier={session.tier} />
                    </div>
                  </ToolbarItem>
                  <ToolbarItem>
                    <Button
                      variant="plain"
                      style={{ color: "rgba(255,255,255,0.7)" }}
                      onClick={logout}
                      icon={<PowerOffIcon />}
                      aria-label="Logout"
                    />
                  </ToolbarItem>
                </>
              )}
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar isSidebarOpen={isSidebarOpen}>
      <PageSidebarBody>
        <Nav>
          <NavList>
            {NAV_ITEMS.map((item) => (
              <NavItem
                key={item.path}
                isActive={location.pathname === item.path}
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </NavItem>
            ))}
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <Page masthead={masthead} sidebar={sidebar}>
      {children}
    </Page>
  );
}
