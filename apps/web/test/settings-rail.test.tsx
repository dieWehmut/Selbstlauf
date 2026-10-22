import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsRail } from '../src/settings/SettingsRail';

function Rail() {
  const [active, setActive] = useState('general');
  return <SettingsRail active={active} onSelect={setActive} onBack={() => undefined} />;
}

describe('settings search keyboard navigation', () => {
  it('keeps a visible tab reachable when search hides the active section', () => {
    render(<Rail />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索设置' }), { target: { value: '托盘' } });
    const tab = screen.getByRole('tab', { name: '启动与托盘' });
    expect(tab).toHaveAttribute('tabindex', '0');
    expect(tab).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(tab, { key: 'ArrowDown' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps arrow keys and supports Home/End', () => {
    render(<Rail />);
    const rail = screen.getByRole('tablist', { name: '设置分区' });
    const tabs = within(rail).getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'ArrowUp' });
    expect(tabs.at(-1)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs.at(-1)!, { key: 'Home' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(tabs.at(-1)).toHaveAttribute('aria-selected', 'true');
  });
});
