import { describe, expect, it } from 'vitest';
import { accessibleTextColor, contrastRatio, parseColor, validateUiAction } from './uiTools';

describe('validated UI tools', () => {
  it('accepts only known appearance actions and bounded values', () => {
    expect(validateUiAction('set_theme', { theme: 'dark' })).toEqual({ type: 'set_theme', theme: 'dark' });
    expect(validateUiAction('set_font_scale', { scale: 1.3 })).toEqual({ type: 'set_font_scale', scale: 1.3 });
    expect(validateUiAction('set_font_scale', { scale: 10 })).toBeNull();
    expect(validateUiAction('set_ui_color', { target: 'pageBackground', color: '#abc' })).toEqual({
      type: 'set_ui_color', target: 'pageBackground', color: '#aabbcc',
    });
    expect(validateUiAction('set_ui_color', { target: 'body', color: '#aabbcc' })).toBeNull();
    expect(validateUiAction('set_ui_color', { target: 'pageBackground', color: 'red; color: transparent' })).toBeNull();
  });

  it('adjusts low contrast text to the nearest readable shade', () => {
    const color = accessibleTextColor('#eeeeee', ['#ffffff']);
    expect(contrastRatio(color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(parseColor(color)).toBe(color);
  });
});
