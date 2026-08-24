import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Divider } from "../../components/ui/Divider";
import { TabGroup } from "../../components/ui/TabGroup";
import { useNavigationListener } from "../../hooks/useNavigationListener";
import { bottomTabSections, getAllTabs, topTabSections } from "./configTabs";
import { DeprecationBanner } from "../../components/DeprecationBanner";
import { AccountDropdown } from "./features/account/AccountDropdown";

function ConfigPage() {
  useNavigationListener();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "settings";

  const allTabs = getAllTabs();

  const handleTabClick = (tabId: string) => {
    if (tabId === "back") {
      navigate("/");
    } else {
      navigate(`/config?tab=${tabId}`);
    }
  };

  return (
    <div className="lumina-settings-page">
      {/* Vertical Sidebar - full height */}
      <aside
        className="lumina-settings-nav"
        aria-label="Secciones de configuración"
      >
        <div className="lumina-settings-nav__scroll thin-scrollbar">
          {topTabSections.map((section) => (
            <React.Fragment key={section.id}>
              <TabGroup
                tabs={section.tabs}
                activeTab={activeTab}
                onTabClick={handleTabClick}
                showTopDivider={section.showTopDivider}
                showBottomDivider={section.showBottomDivider}
                className={section.className}
              />
            </React.Fragment>
          ))}

          <div className="flex-1" />

          {bottomTabSections.map((section) => (
            <TabGroup
              key={section.id}
              tabs={section.tabs}
              activeTab={activeTab}
              onTabClick={handleTabClick}
              showTopDivider={section.showTopDivider}
              showBottomDivider={section.showBottomDivider}
              className={section.className}
            />
          ))}

          <Divider />

          <AccountDropdown />
        </div>
      </aside>

      {/* Main content area */}
      <div className="lumina-settings-content">
        <div className="thin-scrollbar relative flex-1 overflow-y-auto">
          <DeprecationBanner dismissable={true} />
          <div className="lumina-settings-content__inner space-y-6">
            {allTabs.find((tab) => tab.id === activeTab)?.component}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConfigPage;
