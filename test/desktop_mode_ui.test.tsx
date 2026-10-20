// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { DesktopModeSwitch } from '../src/components/desktop/DesktopModeSwitch';
import { renderChatPanelHeader } from '../src/components/agent_chat/chat_panel_header_view';
import { renderDesktopCoreStage } from '../src/components/desktop/core_stage_view';
import { useDesktopWallpaper } from '../src/components/desktop/state/use_desktop_wallpaper';

const native = vi.hoisted(() => ({
  getWallpaperMode: vi.fn(), setWallpaperMode: vi.fn(), setAlwaysOnTop: vi.fn(),
}));
vi.mock('../src/services/systemService', () => ({ systemService: native }));
vi.mock('../src/components/desktop/widget', () => ({ LumiCoreAvatar: () => <div data-orb-fixture /> }));
vi.mock('../src/components/VoicePicker', () => ({ VoicePicker: () => null }));
vi.mock('../src/components/DesktopShellAuxiliary', () => ({ MeetingModeButton: () => null }));
vi.mock('../src/components/SpriteAnimator', () => ({ PetAvatar: () => null }));
vi.mock('../src/components/biometrics/PresenceIndicator', () => ({ PresenceIndicator: () => null }));
vi.mock('../src/components/VoiceCallButton', () => ({ VoiceCallButton: () => null }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it('reports an unconfirmed save without entering wallpaper or publishing a mode', async () => {
  const setPreference = vi.fn(async () => false);
  const view = render(<DesktopModeSwitch preference="internal" setPreference={setPreference} appearance="light" lang="zh" />);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: '外部模式' })); });
  expect(toast.error).toHaveBeenCalledWith('模式切换未确认，请检查连接后重试');
  expect(view.getByRole('button', { name: '内部模式' }).getAttribute('aria-pressed')).toBe('true');
  expect(native.setWallpaperMode).not.toHaveBeenCalled();
});

describe('one execution preference in both real React placements', () => {
  it.each(['light', 'dark'] as const)('renders accessible controls in personal orb and command header in %s', appearance => {
    const setPreference = vi.fn(async () => true);
    const mode = <DesktopModeSwitch preference="internal" setPreference={setPreference} appearance={appearance} lang="zh" />;
    const header = (control: React.ReactNode) => renderChatPanelHeader({
      desktopModeControl: control, isOfficeCommandCenter: true, chatHeaderStyle: {}, agentName: 'Lumi',
      operationModeMeta: {}, agentCategory: '', activeDomainLabel: '', OperationModeIcon: () => null,
      knowledgeFiles: [], knowledgeLoading: false, knowledgeStatusText: '', callState: 'idle', audioLevel: 0,
      startVoiceSession: vi.fn(), endVoiceSession: vi.fn(), voices: [], activeDomain: 'personal',
      setShowWeChatSettings: vi.fn(), setCommandCenterPlannerOpen: vi.fn(), commandCenterPlannerOpen: false,
      commandCenterPlannerText: {}, searchQuery: '', setSearchQuery: vi.fn(), setSearchResults: vi.fn(), setSearchError: vi.fn(),
    } as any);
    const core = (preference: 'internal' | 'external') => renderDesktopCoreStage({
      selectedPet: null, callState: 'idle', t: {}, lang: 'zh', operationMode: 'assistant',
      facePresenceRequested: false, wakeEnabled: false, isWallpaperMode: false, desktopExecutionPreference: preference, setDesktopExecutionPreference: setPreference,
      resolvedAppearanceMode: appearance, wakeWord: {}, presence: {}, faceRecognition: { result: { facePresent: false } },
    } as any);
    const view = render(<>{header(mode)}{core('internal')}</>);
    const groups = view.getAllByRole('group', { name: '程序模式' });
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(within(group).getByRole('button', { name: '内部模式' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(within(group).getByRole('button', { name: '外部模式' }));
    }
    expect(setPreference).toHaveBeenNthCalledWith(1, 'external');
    expect(setPreference).toHaveBeenNthCalledWith(2, 'external');
    expect(native.setWallpaperMode).not.toHaveBeenCalled();
    const external = <DesktopModeSwitch preference="external" setPreference={setPreference} appearance={appearance} lang="zh" />;
    view.rerender(<>{header(external)}{core('external')}</>);
    for (const group of view.getAllByRole('group', { name: '程序模式' })) {
      expect(within(group).getByRole('button', { name: '外部模式' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(within(group).getByRole('button', { name: '内部模式' }));
    }
    expect(setPreference).toHaveBeenLastCalledWith('internal');
    expect(native.setWallpaperMode).not.toHaveBeenCalled();
  });
});

function wallpaper(enabled: boolean) {
  const refs = {
    wallpaperAutomationTimerRef: { current: null }, wallpaperPresentationRef: { current: 'workbench' },
    wallpaperWorkspaceRef: { current: 'personal' }, isWallpaperModeRef: { current: enabled },
    wallpaperNativeTransitionDepthRef: { current: 0 }, wallpaperBeforeAutomationRef: { current: null },
  };
  const sync = (value: boolean, presentation: string, workspace: string) => {
    refs.isWallpaperModeRef.current = value;
    refs.wallpaperPresentationRef.current = presentation;
    refs.wallpaperWorkspaceRef.current = workspace;
  };
  native.getWallpaperMode.mockResolvedValue({ enabled, presentation: 'workbench', workspace: 'personal' });
  native.setWallpaperMode.mockImplementation(async (value, presentation, workspace) => ({ enabled: value, presentation, workspace }));
  native.setAlwaysOnTop.mockResolvedValue(undefined);
  const hook = renderHook(() => useDesktopWallpaper({
    ...refs, inferWallpaperWorkspace: () => 'personal', syncWallpaperModeView: sync,
    chatOpen: false, isDesktopWidgetMode: false, addNotification: vi.fn(), t: {}, isWallpaperMode: enabled,
    socket: null, setMcpActivities: vi.fn(),
  } as any));
  const relay = async (value: boolean, timeoutMs?: number) => {
    let response: any;
    await act(async () => {
      response = await new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent('lumi:set-wallpaper-mode', {
        detail: { enabled: value, timeoutMs, respond: resolve, reject },
      })));
    });
    return response;
  };
  return { hook, refs, relay };
}
describe('existing automation restoration owns no separate mode state', () => {
  it('publishes the native acknowledgement rather than an unconfirmed requested mode', async () => {
    const w = wallpaper(false);
    await act(async () => {});
    let accept!: (value: any) => void;
    native.setWallpaperMode.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    let pending!: Promise<any>;
    act(() => { pending = w.hook.result.current.applyWallpaperMode(true, { presentation: 'workbench' }); });
    expect(w.refs.isWallpaperModeRef.current).toBe(false);
    await act(async () => {
      accept({ enabled: true, presentation: 'workbench', workspace: 'personal' });
      await pending;
    });
    expect(w.refs.isWallpaperModeRef.current).toBe(true);
  });
  it.each([false, true])('restores the actual initial mode %s after the same controlled session', async enabled => {
    const w = wallpaper(enabled);
    await act(async () => {});
    await w.relay(true, 190_000);
    expect(w.refs.wallpaperPresentationRef.current).toBe('desktop-control');
    expect(await w.relay(false)).toEqual({ enabled, presentation: 'workbench', workspace: 'personal' });
  });
  it('does not overwrite a manual external choice with the old internal restore target', async () => {
    const w = wallpaper(false);
    await act(async () => {});
    await w.relay(true);
    await act(async () => { await w.hook.result.current.applyWallpaperMode(true, { presentation: 'workbench' }); });
    expect(await w.relay(false)).toEqual({ enabled: true, presentation: 'workbench', workspace: 'personal' });
  });
  it('late cleanup after the lease timeout cannot disable a manually selected external workbench', async () => {
    vi.useFakeTimers();
    const w = wallpaper(false);
    await act(async () => {});
    await w.relay(true, 15_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { await w.hook.result.current.applyWallpaperMode(true, { presentation: 'workbench' }); });
    native.setWallpaperMode.mockClear();
    expect(await w.relay(false)).toEqual({ enabled: true, presentation: 'workbench', workspace: 'personal' });
    expect(native.setWallpaperMode).not.toHaveBeenCalled();
  });
  it('a native transition failure restores the existing visible state and rejects the request', async () => {
    const w = wallpaper(false);
    await act(async () => {});
    native.setWallpaperMode.mockRejectedValueOnce(new Error('native failure'));
    await expect(w.relay(true)).rejects.toBe('native failure');
    expect(w.refs.isWallpaperModeRef.current).toBe(false);
    expect(w.refs.wallpaperBeforeAutomationRef.current).toBeNull();
  });
});
