import { useId, useRef, type KeyboardEvent } from 'react';

export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

/** Abas com navegação por setas. O conteúdo do painel é do chamador (use `panelId(key)` em aria-labelledby se quiser). */
export function Tabs({ tabs, value, onChange, label }: { tabs: TabItem[]; value: string; onChange: (key: string) => void; label: string }) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKey(e: KeyboardEvent, index: number) {
    let target = index;
    if (e.key === 'ArrowRight') target = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = tabs.length - 1;
    else return;
    e.preventDefault();
    const tab = tabs[target];
    if (tab) {
      onChange(tab.key);
      refs.current[tab.key]?.focus();
    }
  }

  return (
    <div role="tablist" aria-label={label} className="abas">
      {tabs.map((tab, i) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[tab.key] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${tab.key}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'aba aba-ativa' : 'aba'}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {tab.label}
            {tab.count !== undefined && <span className="aba-contagem">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
