"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import "./app-select.css";

export type AppSelectOption = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

export function AppSelect({ ariaLabel, className, disabled, options, value, onChange }: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  options: AppSelectOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options.find((option) => !option.disabled) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  function choose(next: AppSelectOption) {
    if (next.disabled) return;
    onChange(next.value);
    setOpen(false);
  }

  return <div className={`app-select${open ? " is-open" : ""}${className ? ` ${className}` : ""}`} ref={root}>
    <button
      type="button"
      className="app-select-trigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${id}-listbox`}
      disabled={disabled || !options.length}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
        if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && !open) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      <span><strong>{selected?.label ?? "Select"}</strong>{selected?.detail && <small>{selected.detail}</small>}</span>
      <ChevronDown size={16} aria-hidden="true"/>
    </button>
    {open && <div className="app-select-menu" id={`${id}-listbox`} role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button
        type="button"
        role="option"
        aria-selected={option.value === value}
        disabled={option.disabled}
        key={option.value}
        onClick={() => choose(option)}
      >
        <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
        {option.value === value && <Check size={14} aria-hidden="true"/>}
      </button>)}
    </div>}
  </div>;
}
