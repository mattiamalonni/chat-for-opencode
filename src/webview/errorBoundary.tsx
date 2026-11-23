import { Component, type ComponentChildren } from "preact";

import { useT } from "./i18n";
import { IconError } from "./icons";

/**
 * Catches rendering errors so a single bad message cannot leave the webview blank. A new `session`
 * or a completed resync increments `resetToken`, which retries the render with the fresh data; the
 * reload action remains as a last resort if the same payload keeps throwing.
 */
export class WebviewErrorBoundary extends Component<
  { children: ComponentChildren; resetToken: number },
  { failed: boolean; token: number }
> {
  state = { failed: false, token: this.props.resetToken };

  static getDerivedStateFromProps(props: { resetToken: number }, state: { failed: boolean; token: number }) {
    return props.resetToken !== state.token ? { failed: false, token: props.resetToken } : null;
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[chat] webview render failed", error);
  }

  render() {
    return this.state.failed ? <CrashFallback /> : this.props.children;
  }
}

function CrashFallback() {
  const t = useT();
  return (
    <div class="app">
      <div class="banner error" role="alert">
        <div class="banner-main">
          <IconError />
          <strong>{t("crashTitle")}</strong>
        </div>
        <p class="banner-text">{t("crashBody")}</p>
        <div class="banner-actions">
          <button type="button" class="primary" onClick={() => window.location.reload()}>
            {t("reloadChat")}
          </button>
        </div>
      </div>
    </div>
  );
}
