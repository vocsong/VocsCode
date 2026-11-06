/** Shared layout for settings pages. Persistence stays with each existing settings owner. */
import React, { useId } from 'react';
import { Icon } from './ui';

export function SettingsGroup({ id, title, description, icon, children }: {
  id?: string;
  title: string;
  description?: React.ReactNode;
  icon?: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <section id={id} className="settings-group" aria-labelledby={titleId}>
      <div className="settings-group-heading">
        {icon && <span className="settings-group-icon"><Icon name={icon} size={18} /></span>}
        <div>
          <h3 id={titleId}>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="settings-group-content">{children}</div>
    </section>
  );
}

export function SettingsNote({ children }: { children: React.ReactNode }) {
  return <div className="settings-note"><Icon name="info" size={16} /><div>{children}</div></div>;
}
