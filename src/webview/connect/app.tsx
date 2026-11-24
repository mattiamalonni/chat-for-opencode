import { useEffect, useState } from "preact/hooks";
import type { CredentialSummary, FormField, FormValue, IntegrationInfo, IntegrationMethod } from "../../shared/api";
import type { ConnectAttemptView, ConnectHostMessage } from "../../shared/protocol";
import { STRINGS, type StringKey, type Strings } from "../../shared/strings";
import { StringsContext, useT } from "../i18n";
import { onHostMessage, post } from "./vscode";

type View =
  | { kind: "list" }
  | { kind: "methods"; integration: IntegrationInfo }
  | { kind: "form"; integration: IntegrationInfo; method: IntegrationMethod }
  | { kind: "attempt" };

interface Notice {
  kind: "success" | "error";
  message: string;
}

interface AttemptStatus {
  status: "pending" | "complete" | "failed" | "needs_auth";
  message?: string;
}

function methodLabel(type: IntegrationMethod["type"], t: (key: StringKey) => string, fallback?: string): string {
  if (fallback) return fallback;
  switch (type) {
    case "key":
      return t("connectMethodKey");
    case "oauth":
      return t("connectMethodOAuth");
    case "command":
      return t("connectMethodCommand");
    case "external":
      return t("connectMethodExternal");
    case "env":
      return t("connectMethodEnv");
  }
}

function matches(field: FormField, values: Record<string, FormValue>): boolean {
  return (field.when ?? []).every((rule) => {
    const actual = values[rule.key] ?? "";
    return rule.op === "eq" ? actual === rule.value : actual !== rule.value;
  });
}

function initialValues(fields: FormField[]): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const field of fields) {
    if (field.default !== undefined && ["string", "number", "integer", "boolean", "multiselect"].includes(field.type)) {
      out[field.key] = field.default as FormValue;
    } else if (field.type === "boolean") out[field.key] = false;
    else if (field.type === "multiselect") out[field.key] = [];
    else if (field.options?.length && field.required) out[field.key] = field.options[0].value;
    else out[field.key] = "";
  }
  return out;
}

export function App() {
  const [strings, setStrings] = useState<Strings>({ ...STRINGS });
  return (
    <StringsContext.Provider value={strings}>
      <Connect setStrings={setStrings} />
    </StringsContext.Provider>
  );
}

function Connect({ setStrings }: { setStrings: (value: Strings) => void }) {
  const t = useT();
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState<ConnectAttemptView | null>(null);
  const [status, setStatus] = useState<AttemptStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [renaming, setRenaming] = useState<string | undefined>();
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    const off = onHostMessage((msg: ConnectHostMessage) => {
      switch (msg.type) {
        case "init":
          setStrings(msg.strings);
          break;
        case "integrations":
          setItems(msg.items);
          setCredentials(msg.credentials);
          setLoaded(true);
          break;
        case "attempt":
          setAttempt(msg.attempt);
          setStatus(null);
          setView({ kind: "attempt" });
          break;
        case "attemptStatus":
          setStatus({ status: msg.status, message: msg.message });
          // Fallback for a host that reports the terminal state without closing the attempt.
          if (msg.status === "complete" || msg.status === "failed") {
            setAttempt(null);
            setCode("");
            setView({ kind: "list" });
          }
          break;
        case "attemptClosed":
          setAttempt(null);
          setStatus(null);
          setCode("");
          setView({ kind: "list" });
          break;
        case "notice":
          setNotice({ kind: msg.kind, message: msg.message });
          break;
        case "busy":
          setBusy(msg.busy);
          break;
      }
    });
    post({ type: "ready" });
    return off;
  }, [setStrings]);

  const openForm = (integration: IntegrationInfo, method: IntegrationMethod) => {
    setValues(initialValues(method.form ?? []));
    setCustomValues({});
    setKey("");
    setLabel("");
    setCode("");
    setNotice(null);
    setView({ kind: "form", integration, method });
  };

  /** Env methods cannot be started from a webview: the variable belongs to the server process. */
  const signInMethods = (integration: IntegrationInfo): IntegrationMethod[] =>
    integration.methods.filter((method) => method.type !== "env");

  const signIn = (integration: IntegrationInfo) => {
    const methods = signInMethods(integration);
    if (methods.length === 0) return;
    // One method (e.g. GitHub Copilot's OAuth): skip the picker and open its form directly.
    if (methods.length === 1) openForm(integration, methods[0]);
    else setView({ kind: "methods", integration });
  };

  const back = () => {
    setView(attempt ? { kind: "attempt" } : { kind: "list" });
  };

  const answer = (): Record<string, FormValue> => {
    const out: Record<string, FormValue> = {};
    if (view.kind !== "form") return out;
    for (const field of view.method.form ?? []) {
      if (field.hidden) {
        if (field.default !== undefined) out[field.key] = field.default as FormValue;
        continue;
      }
      if (!matches(field, values)) continue;
      const value = values[field.key] ?? "";
      out[field.key] = value === "__custom__" ? (customValues[field.key] ?? "") : value;
    }
    return out;
  };

  const submit = () => {
    if (view.kind !== "form" || busy) return;
    const labelValue = label.trim() || undefined;
    const fields = answer();
    switch (view.method.type) {
      case "key":
        post({ type: "connectKey", integrationID: view.integration.id, key, answer: fields, label: labelValue });
        // Drop the secret from the DOM as soon as it has been handed to the host.
        setKey("");
        break;
      case "oauth":
        if (!view.method.id) return;
        post({ type: "startOAuth", integrationID: view.integration.id, methodID: view.method.id, answer: fields, label: labelValue });
        break;
      case "external":
        if (!view.method.id) return;
        post({ type: "connectExternal", integrationID: view.integration.id, methodID: view.method.id, answer: fields, label: labelValue });
        break;
      case "command":
        if (!view.method.id) return;
        post({ type: "startCommand", integrationID: view.integration.id, methodID: view.method.id, label: labelValue });
        break;
      case "env":
        return;
    }
  };

  const setField = (field: FormField, value: FormValue) => setValues((prev) => ({ ...prev, [field.key]: value }));

  const fieldInput = (field: FormField) => {
    if (field.hidden || !matches(field, values)) return null;
    const value = values[field.key];
    const id = `field-${field.key}`;
    const common = { id, disabled: busy, title: field.description };
    let input;
    const options = field.options ?? [];
    if (field.type === "boolean") {
      input = <input type="checkbox" checked={value === true} onChange={(e) => setField(field, e.currentTarget.checked)} {...common} />;
    } else if (field.type !== "external" && options.length > 0) {
      // Providers send option lists even for `type: "string"` (e.g. GitHub deployment type).
      // Rendering those as a free-text box made the field unusable.
      const selected = typeof value === "string" || typeof value === "number" ? String(value) : "";
      input = (
        <>
          <select {...common} onChange={(e) => setField(field, e.currentTarget.value)}>
            {!field.required ? <option value="">—</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.description ? `${option.label} — ${option.description}` : option.label}
              </option>
            ))}
            {field.custom ? <option value="__custom__">{t("customAnswer")}</option> : null}
          </select>
          {selected === "__custom__" ? (
            <input
              type="text"
              placeholder={field.placeholder}
              value={customValues[field.key] ?? ""}
              onInput={(e) => setCustomValues((prev) => ({ ...prev, [field.key]: e.currentTarget.value }))}
              {...common}
              id={`${id}-custom`}
            />
          ) : null}
        </>
      );
    } else if (field.type === "multiselect") {
      const selected = Array.isArray(value) ? value : [];
      input = (
        <select
          multiple
          {...common}
          onChange={(e) =>
            setField(
              field,
              Array.from(e.currentTarget.selectedOptions).map((option) => option.value),
            )
          }
        >
          {(field.options ?? []).map((option) => (
            <option value={option.value} selected={selected.includes(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      );
    } else if (field.type === "number" || field.type === "integer") {
      const step = field.type === "integer" ? 1 : "any";
      input = (
        <input
          type="number"
          step={step}
          min={field.minimum}
          max={field.maximum}
          placeholder={field.placeholder}
          value={typeof value === "number" ? String(value) : ""}
          onInput={(e) =>
            setField(field, field.type === "integer" ? parseInt(e.currentTarget.value, 10) : parseFloat(e.currentTarget.value))
          }
          {...common}
        />
      );
    } else {
      input = (
        <input
          type="text"
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
          onInput={(e) => setField(field, e.currentTarget.value)}
          {...common}
        />
      );
    }
    return (
      <div class="connect-field" key={field.key}>
        <label for={id}>{field.title ?? field.key}</label>
        {input}
        {field.type === "external" && field.url ? (
          <button type="button" class="link" onClick={() => post({ type: "openLink", href: field.url! })}>
            {t("connectOpenBrowser")}
          </button>
        ) : null}
        {field.description ? <small>{field.description}</small> : null}
      </div>
    );
  };

  const query = search.trim().toLowerCase();
  const visibleItems = query
    ? items.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.id.toLowerCase().includes(query) ||
          credentials.some((credential) => credential.integrationID === item.id && credential.label.toLowerCase().includes(query)),
      )
    : items;

  // Accounts live at the top of the panel: with hundreds of providers, finding one by scrolling
  // the provider list is impractical. Active accounts come first.
  const visibleAccounts = [...credentials]
    .sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label))
    .filter((credential) => {
      if (!query) return true;
      const provider = items.find((item) => item.id === credential.integrationID);
      return credential.label.toLowerCase().includes(query) || (provider?.name ?? credential.integrationID).toLowerCase().includes(query);
    });

  const accountCard = (credential: CredentialSummary) => {
    const integration = items.find((item) => item.id === credential.integrationID);
    return (
      <li class="connect-account" key={credential.id}>
        <div class="connect-account-main">
          <span class="connect-avatar" aria-hidden="true">
            {(credential.label || "?").slice(0, 1).toUpperCase()}
          </span>
          <strong>{credential.label}</strong>
          <span class="connect-muted">
            {integration?.name ?? credential.integrationID} · {credential.type}
          </span>
        </div>
        <div class="connect-account-actions">
          {credential.active ? (
            <span class="connect-badge connect-badge-active">{t("connectActive")}</span>
          ) : (
            <button
              type="button"
              class="connect-action"
              disabled={busy}
              onClick={() => post({ type: "activateCredential", id: credential.id })}
            >
              {t("connectActivate")}
            </button>
          )}
          <button
            type="button"
            class="connect-action"
            disabled={busy}
            onClick={() => {
              setRenaming(credential.id);
              setRenameValue(credential.label);
            }}
          >
            {t("connectRename")}
          </button>
          <button
            type="button"
            class="connect-action connect-action-danger"
            disabled={busy}
            onClick={() => post({ type: "deleteCredential", id: credential.id })}
          >
            {t("connectDelete")}
          </button>
        </div>
        {renaming === credential.id ? (
          <div class="connect-inline-form">
            <input
              type="text"
              value={renameValue}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              aria-label={t("connectNewLabel")}
            />
            <button
              type="button"
              disabled={busy || !renameValue.trim()}
              onClick={() => {
                if (!renameValue.trim()) return;
                post({ type: "renameCredential", id: credential.id, label: renameValue.trim() });
                setRenaming(undefined);
              }}
            >
              {t("save")}
            </button>
            <button type="button" onClick={() => setRenaming(undefined)}>
              {t("connectCancel")}
            </button>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <main class="connect-app">
      <header class="connect-header">
        <div>
          <h1>{t("appName")} · /connect</h1>
          <p class="connect-muted">{t("connectSubtitle")}</p>
        </div>
        <button type="button" class="connect-refresh" disabled={busy} onClick={() => post({ type: "refresh" })}>
          <span aria-hidden="true">↻</span> {t("connectRefresh")}
        </button>
      </header>

      {notice ? (
        <div class={`connect-notice ${notice.kind}`} role="status" onClick={() => setNotice(null)}>
          {notice.message}
        </div>
      ) : null}

      {view.kind === "list" ? (
        <section class="connect-section">
          {visibleAccounts.length > 0 ? (
            <div class="connect-connected">
              <h2>{t("connectConnectedAccounts")}</h2>
              <ul class="connect-accounts">{visibleAccounts.map(accountCard)}</ul>
            </div>
          ) : null}
          {loaded && items.length > 0 ? (
            <div class="connect-search-wrap">
              <span class="connect-search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                type="text"
                class="connect-search"
                placeholder={t("connectSearch")}
                value={search}
                aria-label={t("connectSearch")}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
            </div>
          ) : null}
          {!loaded ? <p class="connect-state">{t("connectLoading")}</p> : null}
          {loaded && items.length === 0 ? <p class="connect-state">{t("connectEmpty")}</p> : null}
          {loaded && items.length > 0 && visibleItems.length === 0 ? <p class="connect-state">{t("noFilesOrSkillsFound")}</p> : null}
          <ul class="connect-providers">
            {visibleItems.map((integration) => {
              const accounts = credentials.filter((credential) => credential.integrationID === integration.id);
              const methods = signInMethods(integration);
              return (
                <li key={integration.id}>
                  <button
                    type="button"
                    class="connect-provider"
                    disabled={busy || methods.length === 0}
                    aria-label={`${integration.name} — ${t("connectAddAccount")}`}
                    onClick={() => signIn(integration)}
                  >
                    <span class="connect-provider-head">
                      <strong>{integration.name}</strong>
                    </span>
                    <span class="connect-provider-meta">
                      {methods.map((method, index) => (
                        <span class="connect-chip" key={`${method.type}-${index}`}>
                          {methodLabel(method.type, t, method.label)}
                        </span>
                      ))}
                      {accounts.length > 0 ? (
                        <span class="connect-badge">
                          {accounts.length} {t("connectAccounts").toLowerCase()}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {view.kind === "methods" ? (
        <section class="connect-section connect-subview">
          <button type="button" class="link" onClick={back}>
            ← {t("connectBack")}
          </button>
          <h2>{view.integration.name}</h2>
          <ul class="connect-methods">
            {signInMethods(view.integration).map((method, index) => (
              <li key={`${method.type}-${index}`}>
                <button type="button" disabled={busy} onClick={() => openForm(view.integration, method)}>
                  {methodLabel(method.type, t, method.label)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.kind === "form" ? (
        <section class="connect-section connect-subview connect-form-panel">
          <button type="button" class="link" onClick={back}>
            ← {t("connectBack")}
          </button>
          <h2>
            {view.integration.name} · {methodLabel(view.method.type, t, view.method.label)}
          </h2>
          {view.method.type === "key" ? (
            <div class="connect-field">
              <label for="connect-key">{t("connectApiKey")}</label>
              <input
                id="connect-key"
                type="password"
                autocomplete="off"
                placeholder={t("connectApiKeyPlaceholder")}
                value={key}
                disabled={busy}
                onInput={(e) => setKey(e.currentTarget.value)}
              />
              <small>{t("connectKeyHelp")}</small>
            </div>
          ) : null}
          {(view.method.form ?? []).map(fieldInput)}
          <div class="connect-field">
            <label for="connect-label">{t("connectAccountLabel")}</label>
            <input
              id="connect-label"
              type="text"
              placeholder={t("connectAccountLabelPlaceholder")}
              value={label}
              disabled={busy}
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
          </div>
          <div class="connect-form-actions">
            <button type="button" disabled={busy || (view.method.type === "key" && !key.trim())} onClick={submit}>
              {t("connectSubmit")}
            </button>
            <button type="button" disabled={busy} onClick={back}>
              {t("connectCancel")}
            </button>
          </div>
        </section>
      ) : null}

      {view.kind === "attempt" && attempt ? (
        <section class="connect-section connect-subview connect-attempt-panel">
          <h2>
            {attempt.integrationName} · {attempt.methodLabel}
          </h2>
          {attempt.instructions ? <p>{attempt.instructions}</p> : null}
          {attempt.url ? (
            <div class="connect-form-actions">
              <button type="button" onClick={() => post({ type: "openLink", href: attempt.url! })}>
                {t("connectOpenBrowser")}
              </button>
              <button type="button" onClick={() => post({ type: "copy", text: `${attempt.instructions ?? ""}\n${attempt.url}` })}>
                {t("connectCopyDetails")}
              </button>
            </div>
          ) : null}
          {attempt.command && attempt.command.length > 0 ? (
            <div class="connect-field">
              <code class="connect-command">{attempt.command.join(" ")}</code>
              <button type="button" disabled={busy} onClick={() => post({ type: "runCommand" })}>
                {t("connectRunCommand")}
              </button>
            </div>
          ) : null}
          {attempt.paste || attempt.kind === "oauth" ? (
            <div class="connect-field">
              <label for="connect-code">{t("connectCode")}</label>
              <input
                id="connect-code"
                type="text"
                placeholder={t("connectCodePlaceholder")}
                value={code}
                disabled={busy}
                onInput={(e) => setCode(e.currentTarget.value)}
              />
              <small>{t("connectCodeHelp")}</small>
            </div>
          ) : null}
          <div class="connect-form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (attempt.kind === "oauth" && (attempt.paste || attempt.mode === "code") && code.trim()) {
                  post({ type: "completeOAuth", code: code.trim() });
                  setCode("");
                } else {
                  post({ type: "checkAttempt" });
                }
              }}
            >
              {t("connectComplete")}
            </button>
            <button type="button" disabled={busy} onClick={() => post({ type: "cancelAttempt" })}>
              {t("connectCancel")}
            </button>
          </div>
          {status ? (
            <p class={`connect-status ${status.status === "pending" ? "connect-status-pending" : ""}`} role="status">
              {status.status === "pending" ? t("connectWaiting") : (status.message ?? status.status)}
            </p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
