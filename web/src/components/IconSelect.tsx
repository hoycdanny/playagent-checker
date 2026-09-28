import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './IconSelect.css';

export interface IconSelectOption {
  value: string;
  label: string;
  /** 選項左側圖示(可選)。 */
  icon?: ReactNode;
}

export interface IconSelectProps {
  value: string;
  options: IconSelectOption[];
  onChange: (value: string) => void;
  /** 未選時顯示的提示。 */
  placeholder?: string;
  /** 無障礙標籤(觸發按鈕的 aria-label)。 */
  ariaLabel?: string;
  className?: string;
}

/**
 * 可顯示圖示的下拉選單(原生 <select> 無法在 option 內渲染 SVG)。
 * 採 ARIA listbox 模式:
 * - 按鈕 role=button + aria-haspopup=listbox + aria-expanded。
 * - 展開清單 role=listbox,選項 role=option + aria-selected。
 * - 鍵盤:上/下移動、Enter/Space 選取、Esc 關閉、點擊外部關閉。
 */
export default function IconSelect({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: IconSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  // 開啟時把焦點列對齊到目前選取項。
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  // 點擊外部關閉。
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function commit(index: number) {
    const opt = options[index];
    if (opt) {
      onChange(opt.value);
      setOpen(false);
    }
  }

  function onButtonKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    }
  }

  return (
    <div className={`iconselect${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="iconselect__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="iconselect__value">
          {selected ? (
            <>
              {selected.icon && <span className="iconselect__icon">{selected.icon}</span>}
              <span>{selected.label}</span>
            </>
          ) : (
            <span className="iconselect__placeholder">{placeholder}</span>
          )}
        </span>
        <span className="iconselect__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <ul
          className="iconselect__list"
          role="listbox"
          id={listId}
          tabIndex={-1}
          aria-activedescendant={`${listId}-opt-${activeIndex}`}
          onKeyDown={onListKeyDown}
          ref={(el) => el?.focus()}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={opt.value === value}
              className={`iconselect__option${
                i === activeIndex ? ' iconselect__option--active' : ''
              }${opt.value === value ? ' iconselect__option--selected' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => commit(i)}
            >
              {opt.icon && <span className="iconselect__icon">{opt.icon}</span>}
              <span className="iconselect__option-label">{opt.label}</span>
              {opt.value === value && (
                <span className="iconselect__check" aria-hidden="true">
                  ✓
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
