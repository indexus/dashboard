import { useEffect, useRef, useState } from "react";

function ModalShell({ open, title, hint, onClose, children, actions }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    const timer = setTimeout(() => {
      dialogRef.current?.querySelector("input")?.focus();
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;
  const titleId = `resource-modal-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        className="modal-dialog resource-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="ghost compact modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {hint ? <p className="modal-hint">{hint}</p> : null}
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

/** Keep in sync with dashboard/lib/networkRegistry.js slugifyNetworkId. */
function slugifyNetworkId(label) {
  const slug = String(label || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug) ? slug : "";
}

export function NetworkCreateModal({ open, busy, error, onClose, onCreate }) {
  const [draft, setDraft] = useState({
    label: "",
    kind: "aws",
    boot_ip: "",
  });

  useEffect(() => {
    if (!open) {
      setDraft({ label: "", kind: "aws", boot_ip: "" });
    }
  }, [open]);

  const networkId = slugifyNetworkId(draft.label);

  async function submit(event) {
    event.preventDefault();
    if (!networkId) return;
    const provisionsAws = draft.kind === "aws";
    if (
      provisionsAws &&
      !confirm(
        `Spin up AWS bootstrap for "${draft.label.trim()}" (${networkId})?\n\nThis starts one EC2 bootstrap node on the shared platform (no new S3/IAM/VPC).`,
      )
    ) {
      return;
    }
    await onCreate?.({
      label: draft.label.trim(),
      kind: draft.kind === "local" ? "local" : "aws",
      provision: provisionsAws,
      boot_ip: draft.boot_ip,
    });
  }

  return (
    <ModalShell
      open={open}
      title="Create network"
      hint="A network is a bootstrap node (plus the peers it spawns). Switch networks by switching bootstraps. Id = slug of the label."
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !networkId}
            form="network-create-form"
          >
            {busy
              ? draft.kind === "aws"
                ? "Spinning bootstrap…"
                : "Creating…"
              : "Create network"}
          </button>
        </>
      }
    >
      <form id="network-create-form" className="resource-modal-form" onSubmit={submit}>
        <label className="field">
          label
          <input
            required
            value={draft.label}
            onChange={(event) =>
              setDraft((current) => ({ ...current, label: event.target.value }))
            }
            placeholder="My first network"
          />
        </label>
        <div className="field-hint" title="Derived automatically from the label">
          id · {networkId || "—"}
        </div>
        <label className="field">
          bootstrap
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft((current) => ({ ...current, kind: event.target.value }))
            }
          >
            <option value="aws">AWS · spin up bootstrap</option>
            <option value="aws-existing">AWS · use existing bootstrap IP</option>
            <option value="local">Local lab · mesh on this machine</option>
          </select>
        </label>
        {draft.kind === "aws-existing" ? (
          <label className="field">
            bootstrap IP
            <input
              required
              value={draft.boot_ip}
              onChange={(event) =>
                setDraft((current) => ({ ...current, boot_ip: event.target.value }))
              }
              placeholder="15.237.x.x"
            />
          </label>
        ) : null}
        {draft.kind === "aws" ? (
          <p className="field-hint">
            Reuses the shared AWS platform (AMI, SG, IAM, launch template). Only
            one bootstrap EC2 is created for this network.
          </p>
        ) : null}
        {error ? <div className="status-line err">{error}</div> : null}
      </form>
    </ModalShell>
  );
}

export function CollectionCreateModal({
  open,
  busy,
  error,
  networkLabel,
  onClose,
  onCreate,
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) setName("");
  }, [open]);

  async function submit(event) {
    event.preventDefault();
    await onCreate?.(name.trim());
  }

  return (
    <ModalShell
      open={open}
      title="Create collection"
      hint={`Create an empty collection in ${networkLabel || "the active network"}.`}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !name.trim()}
            form="collection-create-form"
          >
            {busy ? "Creating…" : "Create collection"}
          </button>
        </>
      }
    >
      <form
        id="collection-create-form"
        className="resource-modal-form"
        onSubmit={submit}
      >
        <label className="field">
          name
          <input
            required
            maxLength={16}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="geo_load"
          />
        </label>
        <p className="modal-hint">Up to 16 characters. Data is created on the first write.</p>
        {error ? <div className="status-line err">{error}</div> : null}
      </form>
    </ModalShell>
  );
}
