import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  Link,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { Languages, Menu, Moon, Sun, X } from "lucide-react";
import type { MarketRegion } from "../types";

interface MobileMenu {
  menuLabel: string;
  closeLabel: string;
  navigationLabel: string;
  preferencesLabel: string;
  languageSettingLabel: string;
  appearanceSettingLabel: string;
  darkModeLabel: string;
  lightModeLabel: string;
  dailyLabel: string;
  weeklyLabel: string;
  archiveLabel: string;
  dailyHref: string;
  weeklyHref: string;
  archiveHref: string;
  showArchive: boolean;
  active: "daily" | "weekly";
}

interface Props {
  languageHref: string;
  languageLabel: string;
  darkLabel: string;
  lightLabel: string;
  market?: MarketRegion;
  marketLabel?: string;
  cnHref?: string;
  usHref?: string;
  mobileMenu: MobileMenu;
}

export default function HeaderActions({
  languageHref,
  languageLabel,
  darkLabel,
  lightLabel,
  market,
  marketLabel,
  cnHref,
  usHref,
  mobileMenu,
}: Props) {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    setDarkMode(document.documentElement.dataset.theme === "dark");
  }, []);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    window.localStorage.setItem("stock-daily-theme", next ? "dark" : "light");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next ? "#101816" : "#f5f0e6");
  }

  const targetLanguage = languageLabel.includes("English") ? "English" : "中文";
  const targetTheme = darkMode
    ? mobileMenu.lightModeLabel
    : mobileMenu.darkModeLabel;

  return (
    <div className="header-actions">
      {market && cnHref && usHref && (
        <nav className="market-switcher" aria-label={marketLabel}>
          <Link
            className={market === "CN" ? "active" : undefined}
            href={cnHref}
            aria-current={market === "CN" ? "page" : undefined}
          >
            CN
          </Link>
          <Link
            className={market === "US" ? "active" : undefined}
            href={usHref}
            aria-current={market === "US" ? "page" : undefined}
          >
            US
          </Link>
        </nav>
      )}
      <div className="desktop-header-controls">
        <Link
          className="control-button language-button"
          href={languageHref}
          aria-label={languageLabel}
        >
          <Languages aria-hidden="true" />
          <span>{languageLabel.includes("English") ? "EN" : "中"}</span>
        </Link>
        <Button
          className="control-button"
          onPress={toggleTheme}
          aria-label={darkMode ? lightLabel : darkLabel}
          aria-pressed={darkMode}
        >
          {darkMode ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Button>
      </div>
      <DialogTrigger>
        <Button
          className="control-button mobile-menu-trigger"
          aria-label={mobileMenu.menuLabel}
        >
          <Menu aria-hidden="true" />
        </Button>
        <ModalOverlay className="mobile-drawer-overlay" isDismissable>
          <Modal className="mobile-drawer">
            <Dialog className="mobile-drawer-dialog">
              {({ close }) => (
                <>
                  <header>
                    <div>
                      <span>Stock Daily</span>
                      <h2 slot="title">{mobileMenu.menuLabel}</h2>
                    </div>
                    <Button
                      className="drawer-close"
                      onPress={close}
                      aria-label={mobileMenu.closeLabel}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </header>
                  <nav
                    className="mobile-drawer-nav"
                    aria-label={mobileMenu.navigationLabel}
                  >
                    <span>{mobileMenu.navigationLabel}</span>
                    <Link
                      className={
                        mobileMenu.active === "daily" ? "active" : undefined
                      }
                      href={mobileMenu.dailyHref}
                      aria-current={
                        mobileMenu.active === "daily" ? "page" : undefined
                      }
                      onPress={close}
                    >
                      {mobileMenu.dailyLabel}
                    </Link>
                    <Link
                      className={
                        mobileMenu.active === "weekly" ? "active" : undefined
                      }
                      href={mobileMenu.weeklyHref}
                      aria-current={
                        mobileMenu.active === "weekly" ? "page" : undefined
                      }
                      onPress={close}
                    >
                      {mobileMenu.weeklyLabel}
                    </Link>
                    {mobileMenu.showArchive && (
                      <Link href={mobileMenu.archiveHref} onPress={close}>
                        {mobileMenu.archiveLabel}
                      </Link>
                    )}
                  </nav>
                  <div className="mobile-drawer-preferences">
                    <span>{mobileMenu.preferencesLabel}</span>
                    <Link
                      className="drawer-setting mobile-drawer-language"
                      href={languageHref}
                      aria-label={languageLabel}
                      onPress={close}
                    >
                      <span className="drawer-setting-icon">
                        <Languages aria-hidden="true" />
                      </span>
                      <span>
                        <small>{mobileMenu.languageSettingLabel}</small>
                        <strong>{targetLanguage}</strong>
                      </span>
                    </Link>
                    <Button
                      className="drawer-setting mobile-drawer-theme"
                      onPress={toggleTheme}
                      aria-label={darkMode ? lightLabel : darkLabel}
                      aria-pressed={darkMode}
                    >
                      <span className="drawer-setting-icon">
                        {darkMode ? (
                          <Sun aria-hidden="true" />
                        ) : (
                          <Moon aria-hidden="true" />
                        )}
                      </span>
                      <span>
                        <small>{mobileMenu.appearanceSettingLabel}</small>
                        <strong>{targetTheme}</strong>
                      </span>
                    </Button>
                  </div>
                </>
              )}
            </Dialog>
          </Modal>
        </ModalOverlay>
      </DialogTrigger>
    </div>
  );
}
