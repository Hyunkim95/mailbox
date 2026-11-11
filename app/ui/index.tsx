"use client";
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { LoaderCircle, X } from "lucide-react";

/*
 * The component set. Screens compose these and carry no styling of their own.
 * Styles live in ./ui.css and read only the tokens in ../tokens.css.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "small" | "icon" | "danger";
  busy?: boolean;
};
export function Button({
  variant = "default",
  busy = false,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`ui-btn ${variant === "default" ? "" : `is-${variant}`} ${className}`.trim()}
      {...rest}
    >
      {busy ? <LoaderCircle className="spin" size={15} /> : children}
    </button>
  );
}

export function LinkButton({
  quiet = false,
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { quiet?: boolean }) {
  return (
    <button
      type={type}
      className={`ui-link ${quiet ? "is-quiet" : ""} ${className}`.trim()}
      {...rest}
    />
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "danger" | "ok";
  children: ReactNode;
}) {
  return (
    <span className={`ui-badge ${tone === "neutral" ? "" : `is-${tone}`}`}>
      {children}
    </span>
  );
}

/** A letter tile for things that are not agents: a service, the signed-in person. */
export function Tile({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="ui-tile">
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function Tabs({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: string; label: string; count?: number }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav className="ui-tabs" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={value === item.id ? "page" : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined && <span> {item.count}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          disabled={disabled}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SectionHead({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="ui-section-head">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Banner({
  tone = "ok",
  onDismiss,
  children,
}: {
  tone?: "ok" | "danger";
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`ui-banner ${tone === "danger" ? "is-danger" : ""}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span>{children}</span>
      <Button
        variant="icon"
        aria-label={tone === "danger" ? "Dismiss error" : "Dismiss notice"}
        onClick={onDismiss}
      >
        ×
      </Button>
    </div>
  );
}

/** A native modal dialog. Closes on Escape, on the close button and on a click outside. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="ui-dialog"
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <Button
        variant="icon"
        className="ui-dialog-close"
        aria-label="Close dialog"
        onClick={onClose}
        autoFocus
      >
        <X size={18} />
      </Button>
      {children}
    </dialog>
  );
}
