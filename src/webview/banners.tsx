import { useState } from "preact/hooks";
import { SUPPORTED_SERVER_VERSION } from "../shared/compatibility";

import { contractSignature, type ContractReport } from "../shared/contract";
import type { ActionId, ConnectionStatus, UiError } from "../shared/protocol";

import { useT } from "./i18n";
import { IconCheck, IconClose, IconError, IconWarning } from "./icons";

import { ActionButton } from "./messages";
import { post } from "./vscode";

export function StatusBanner({ status, error }: { status: ConnectionStatus; error?: UiError }) {
  const t = useT();
  if (status === "connected" || status === "idle") return null;
  if (status === "starting") {
    return (
      <div class="banner info" role="status">
        <span class="spinner" aria-hidden="true" /> {t("connecting")}
      </div>
    );
  }
  if (status === "reconnecting") {
    return (
      <div class="banner warning" role="status">
        <span class="spinner" aria-hidden="true" /> {error?.message ?? t("reconnecting")}
        <span class="banner-actions">
          <ActionButton id="reconnect" />
        </span>
      </div>
    );
  }
  return error ? <ErrorBlock error={error} /> : null;
}

function ErrorBlock({ error, onDismiss }: { error: UiError; onDismiss?: () => void }) {
  const t = useT();
  return (
    <div class="banner error" role="alert">
      <div class="banner-main">
        <IconError />
        <strong>{error.message}</strong>
        {onDismiss && (
          <button
            type="button"
            class="icon-button dismiss tooltip-host"
            data-tooltip={t("dismiss")}
            aria-label={t("dismiss")}
            onClick={onDismiss}
          >
            <IconClose />
          </button>
        )}
      </div>
      {error.detail &&
        (SETUP_ERROR_KINDS.has(error.kind) ? (
          <pre class="banner-detail-inline">{error.detail}</pre>
        ) : (
          <details class="banner-detail">
            <summary>{t("details")}</summary>
            <pre>{error.detail}</pre>
          </details>
        ))}
      <div class="banner-actions">
        {error.actions.map((a) => (
          <ActionButton key={a} id={a} />
        ))}
      </div>
    </div>
  );
}

/**
 * Empty state for a setup blocker. The banner above explains the failure; this turns it into a
 * short checklist so a first-run user knows what to do next instead of staring at chat prompts.
 */
export function SetupWelcome({ error }: { error: UiError }) {
  const t = useT();
  const steps: Array<{ label: string; done: boolean; action?: ActionId }> = [
    {
      label: t("setupTrust"),
      done: error.kind !== "untrustedWorkspace" && error.kind !== "noWorkspace",
      action: error.kind === "noWorkspace" ? "openFolder" : error.kind === "untrustedWorkspace" ? "trustWorkspace" : undefined,
    },
    {
      label: t("setupInstall"),
      done: error.kind !== "startFailed",
      action: error.kind === "startFailed" ? "install" : undefined,
    },
    {
      label: t("setupProvider"),
      done: error.kind !== "noProvider",
      action: error.kind === "noProvider" ? "login" : undefined,
    },
  ];
  return (
    <div class="welcome setup" aria-label={t("setupTitle")}>
      <h2>{t("setupTitle")}</h2>
      <p>{t("setupBody")}</p>
      <ol class="setup-steps">
        {steps.map((step) => (
          <li class={step.done ? "done" : "pending"} key={step.label}>
            <span class="setup-step-icon" aria-hidden="true">
              {step.done ? <IconCheck /> : <IconError />}
            </span>
            <span class="setup-step-label">{step.label}</span>
            {step.action && <ActionButton id={step.action} />}
          </li>
        ))}
      </ol>
      {/* The banner above already states the error; point at Retry only when it offers one. */}
      {error.actions.includes("reconnect") && <p class="welcome-hint">{t("setupHint")}</p>}
    </div>
  );
}

/** Warns when the server version differs from the one this extension was verified against. */
export function CompatibilityBanner(props: { status: "untested" | "unsupported"; version?: string; issuesUrl?: string }) {
  const { status, version, issuesUrl } = props;
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const unsupported = status === "unsupported";
  return (
    <div class={`banner ${unsupported ? "error" : "warning"}`} role={unsupported ? "alert" : "status"}>
      <div class="banner-main">
        <IconWarning />
        <strong>
          {unsupported
            ? t("unsupportedVersion", version ?? "?", SUPPORTED_SERVER_VERSION)
            : t("untestedVersion", version ?? "?", SUPPORTED_SERVER_VERSION)}
        </strong>
        <button
          type="button"
          class="icon-button dismiss tooltip-host"
          data-tooltip={t("dismiss")}
          aria-label={t("dismiss")}
          onClick={() => {
            setDismissed(true);
            // Remembered by the host so the banner stays hidden for this version across reloads.
            if (version) post({ type: "dismissCompatibility", version });
          }}
        >
          <IconClose />
        </button>
      </div>
      {issuesUrl && (
        <div class="banner-actions">
          <button type="button" class="link-button" onClick={() => post({ type: "openLink", href: issuesUrl })}>
            {t("reportIssue")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Names the capabilities whose response shape does not match the verified 2.4.1 contract. */
export function ContractBanner({ failures, issuesUrl }: { failures: ContractReport["failures"]; issuesUrl?: string }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div class="banner warning" role="status">
      <div class="banner-main">
        <IconWarning />
        <strong>{t("contractTitle")}</strong>
        <button
          type="button"
          class="icon-button dismiss tooltip-host"
          data-tooltip={t("dismiss")}
          aria-label={t("dismiss")}
          onClick={() => {
            setDismissed(true);
            post({ type: "dismissContract", signature: contractSignature({ checked: failures.length, failures }) });
          }}
        >
          <IconClose />
        </button>
      </div>
      <ul class="contract-failures">
        {failures.map((f) => (
          <li key={f.id}>
            <span>{t(`contract.${f.id}` as Parameters<typeof t>[0])}</span>
            <small>{f.detail}</small>
          </li>
        ))}
      </ul>
      {issuesUrl && (
        <div class="banner-actions">
          <button type="button" class="link-button" onClick={() => post({ type: "openLink", href: issuesUrl })}>
            {t("reportIssue")}
          </button>
        </div>
      )}
    </div>
  );
}

export function NoticeBanner({ error, onDismiss }: { error: UiError; onDismiss: () => void }) {
  return <ErrorBlock error={error} onDismiss={onDismiss} />;
}

import { SETUP_ERROR_KINDS } from "./setupErrors";
