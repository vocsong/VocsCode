/** Shared ACP agent preset controls reused by New Session and in-place Switch Harness. */
import type { AcpAgentPreset } from '../../../shared/types';
import { Field, MenuItem } from './ui';

/** Dropdown field used in dialogs (New Session). */
export function AcpPresetSelect({
  presets,
  value,
  onChange
}: {
  presets: AcpAgentPreset[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field label="ACP agent">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {presets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <span className="field-hint">{presets.find((a) => a.id === value)?.description}</span>
    </Field>
  );
}

/** Menu list used inside dropdowns and drill-in views (Switch Harness). */
export function AcpPresetMenuList({
  presets,
  currentId,
  disabled,
  onSelect
}: {
  presets: AcpAgentPreset[];
  currentId?: string;
  disabled?: boolean;
  onSelect: (preset: AcpAgentPreset) => void;
}) {
  if (!presets.length) {
    return <div className="run-more-note">No ACP agent presets configured.</div>;
  }
  return (
    <>
      {presets.map((preset) => {
        const current = preset.id === currentId;
        return (
          <MenuItem
            key={preset.id}
            active={current}
            disabled={disabled}
            hint={current ? 'Current' : preset.description}
            onClick={() => {
              if (!current) onSelect(preset);
            }}
          >
            {preset.name}
          </MenuItem>
        );
      })}
    </>
  );
}
