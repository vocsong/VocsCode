/** Settings workspace shell: section navigation, search, and page routing. */
import React, { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { invoke, isMac } from '../api';
import { SETTINGS_GROUPS, SETTINGS_PAGES, searchSettings, type SettingsSection } from '../settings-catalog';
import { clearRequestedSettingsSection, openSettings, peekRequestedSettingsSection, subscribeSettingsSection } from '../settings-nav';
import { useStore } from '../store';
import { useMinimalUi } from '../ui-mode';
import { ChatImport } from './ChatImport';
import { ControlSettings } from './ControlSettings';
import { InstructionsSection } from './InstructionsSection';
import { LocalControlSettings } from './LocalControlSettings';
import { PiSection } from './PiSettings';
import { SettingsGroup } from './SettingsPrimitives';
import { VocsAccountSettings } from './VocsAccountSettings';
import { VoiceSection } from './VoiceSettings';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { GeneralSection, HousekeepSection } from './settings/GeneralSection';
import { AcpAgentsSection, HarnessesSection } from './settings/HarnessesSection';
import { ProvidersSection } from './settings/ProvidersSection';
import { RemoteSection } from './settings/RemoteSection';
import { BackgroundModelFields, SessionDefaultsSection } from './settings/SessionDefaultsSection';
import { ShortcutsSection } from './settings/ShortcutsSection';
import { TerminalSection } from './settings/TerminalSection';
import { Button, Icon } from './ui';
import './settings.css';

export type { SettingsSection } from '../settings-catalog';
export { openSettings };

type Section = SettingsSection;

export function SettingsView() {
  const settings = useStore((s) => s.settings)!;
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const [section, setSection] = useState<Section>(() => peekRequestedSettingsSection() ?? 'general');
  const [query, setQuery] = useState('');
  const [destination, setDestination] = useState<{ anchor?: string } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = SETTINGS_PAGES.find((p) => p.id === section)!;
  const searching = !!query.trim();
  const results = searchSettings(query);
  const navigate = (next: Section, anchor?: string, focus = false) => {
    setSection(next);
    setQuery('');
    setDestination(focus ? { anchor } : null);
    if (body.current) body.current.scrollTop = 0;
  };
  useEffect(() => {
    clearRequestedSettingsSection();
    return subscribeSettingsSection((next) => {
      clearRequestedSettingsSection();
      navigate(next);
    });
  }, []);
  useEffect(() => {
    // A new query must expose its first result, not inherit the previous page/list's scroll.
    if (searching && body.current) body.current.scrollTop = 0;
  }, [query, searching]);
  useEffect(() => {
    if (!destination || searching) return;
    const target = destination.anchor ? document.getElementById(destination.anchor) : null;
    // A result leads to a visible setting group, with keyboard focus following the jump.
    if (target) {
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'start' });
    } else heading.current?.focus();
    setDestination(null);
  }, [destination, searching, section]);
  const update = (patch: Partial<AppSettings>) => invoke('settings:update', patch).catch((error: unknown) => {
    toast(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`, 'error');
  });
  // Zen shows the section nav as icons, so each one carries its name as a tooltip.
  const minimal = useMinimalUi();
  return (
    <div className="settings" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault(); e.stopPropagation(); search.current?.focus(); search.current?.select();
      } else if (searching && e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); setQuery(''); search.current?.focus();
      }
    }}>
      <div className="settings-shell">
        <aside className="settings-nav">
          <div className="settings-title">
            <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => setView('chat')} title="Back" aria-label="Back to workspace" />
            <span>Settings</span>
          </div>
          <div className="settings-search">
            <Icon name="search" size={16} />
            <input ref={search} type="search" aria-label="Search settings" placeholder="Search settings…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(''); }
              if (e.key === 'Enter' && results[0]) { e.preventDefault(); navigate(results[0].section, results[0].topic.anchor, true); }
              if (e.key === 'ArrowDown' && searching) { e.preventDefault(); body.current?.querySelector<HTMLButtonElement>('.settings-search-result')?.focus(); }
            }} />
            {query && <Button variant="ghost" size="sm" icon="x" aria-label="Clear search" onClick={() => { setQuery(''); search.current?.focus(); }} />}
          </div>
          <select className="settings-mobile-nav" aria-label="Settings section" value={section} onChange={(e) => navigate(e.target.value as Section)}>
            {SETTINGS_GROUPS.map((group) => <optgroup key={group} label={group}>
              {SETTINGS_PAGES.filter((p) => p.group === group).map((p) => <option key={p.id} value={p.id}>{group} / {p.label}</option>)}
            </optgroup>)}
          </select>
          <nav className="settings-nav-groups" aria-label="Settings sections">
            {SETTINGS_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group}>
                <div className="settings-nav-label">{group}</div>
                {SETTINGS_PAGES.filter((p) => p.group === group).map((p) => (
                  <button key={p.id} type="button" className={`settings-link ${section === p.id && !searching ? 'active' : ''}`} aria-current={section === p.id && !searching ? 'page' : undefined} title={minimal ? p.label : undefined} onClick={() => navigate(p.id)}>
                    <Icon name={p.icon} size={16} /><span>{p.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-nav-footer"><Icon name="search" size={13} /><span>{isMac ? '⌘' : 'Ctrl'} F to find a setting</span></div>
        </aside>
        <div className="settings-main">
          <header className="settings-page-header">
            <div className="settings-breadcrumb">Settings <Icon name="chevronRight" size={12} /> {searching ? 'Search' : page.group}</div>
            <h1 ref={heading} tabIndex={-1}>{searching ? 'Find a setting' : page.label}</h1>
            <p>{searching ? 'Search by what you want to change, not where it lives.' : page.description}</p>
            {!searching && <div className="settings-save-hint"><Icon name="info" size={13} />{page.saveHint}</div>}
          </header>
          <div className="settings-body" ref={body}>
            {searching && <div className="settings-search-results">
              <p className="settings-result-count" role="status">{results.length} {results.length === 1 ? 'result' : 'results'} for “{query.trim()}”</p>
              {results.map((result) => <button key={`${result.section}-${result.topic.label}`} type="button" className="settings-search-result" onClick={() => navigate(result.section, result.topic.anchor, true)}>
                <span className="settings-result-icon"><Icon name={result.icon} size={20} /></span>
                <span className="settings-result-copy"><span className="settings-result-path">{result.group} / {result.pageLabel}</span><strong>{result.topic.label}</strong><span>{result.topic.description}</span></span>
                <Icon name="arrowRight" size={16} />
              </button>)}
              {!results.length && <div className="settings-search-empty"><Icon name="search" size={32} /><h2>No settings found</h2><p>Try “theme”, “API key”, “compaction” or “keyboard”.</p><Button onClick={() => { setQuery(''); search.current?.focus(); }}>Browse all settings</Button></div>}
            </div>}
            {/* Searching never unmounts the current editor or throws away an unsaved draft. */}
            <div className="settings-content" hidden={searching}>
              {section === 'general' && <GeneralSection settings={settings} update={update} navigate={navigate} />}
              {section === 'appearance' && <AppearanceSection settings={settings} update={update} />}
              {section === 'sessions' && <SessionDefaultsSection settings={settings} update={update} />}
              {section === 'assistant' && <BackgroundModelFields settings={settings} update={update} />}
              {section === 'shortcuts' && <ShortcutsSection settings={settings} />}
              {section === 'terminal' && <TerminalSection settings={settings} update={update} />}
              {section === 'account' && <VocsAccountSettings />}
              {section === 'providers' && <ProvidersSection settings={settings} />}
              {section === 'voice' && <VoiceSection settings={settings} />}
              {section === 'harnesses' && <HarnessesSection settings={settings} update={update} />}
              {section === 'import' && <ChatImport />}
              {section === 'housekeep' && <HousekeepSection recentDays={settings.housekeepRecentDays} onSave={(days) => update({ housekeepRecentDays: days })} />}
              {section === 'instructions' && <InstructionsSection />}
              {section === 'pi' && <PiSection />}
              {section === 'acp' && <AcpAgentsSection settings={settings} update={update} />}
              {section === 'remote' && <>
                <SettingsGroup id="remote-browser" title="Browser access" icon="globe"><RemoteSection settings={settings} update={update} /></SettingsGroup>
                <SettingsGroup id="remote-controllers" title="External MCP control" description="Experimental · Connect a controller with explicit desktop grants." icon="shield"><ControlSettings /></SettingsGroup>
                <LocalControlSettings />
              </>}
              {section === 'about' && <AboutSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
