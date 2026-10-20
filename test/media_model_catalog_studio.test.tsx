// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useChatMediaControls } from '../src/components/agent_chat/state/use_chat_media_controls';
import { mediaGenerationCopy } from '../src/i18n/locales/mediaGeneration';
vi.mock('../src/hooks/useLumiOfficialCatalog', () => ({ useLumiOfficialCatalog: () => null }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
import { EMPTY_MEDIA_GENERATION_SOURCES, MediaGenerationStudio, type MediaGenerationStudioProps } from '../src/components/MediaGenerationStudio';
import { videoGenerationOptions } from '../shared/video_generation_options';
import { officialModelOptions } from '../src/components/settings/official_models';
import type { OfficialApiModelCatalog } from '../server/llm/official_api';

const LIVE = 'aliyun/wan3.0-video';
const STALE = 'aliyun/Wan2.2-T2V-A14B';
afterEach(cleanup);
function props(models: string[]): MediaGenerationStudioProps {
  return { ...EMPTY_MEDIA_GENERATION_SOURCES, mode: 'video', locale: 'en', busy: false, status: 'idle', artifacts: [],
    onModeChange: vi.fn(), onSourceChange: vi.fn(), onClose: vi.fn(), onGenerate: vi.fn(),
    onOpenArtifact: vi.fn(), onArtifactReady: vi.fn(), onArtifactError: vi.fn(),
    videoOptions: { text_to_video: { ...videoGenerationOptions({ provider: 'relay', model: STALE })!, provider: 'relay', model: STALE, models } },
  };
}
describe('creation selects available official video models explicitly', () => {
  it('updates only Wan3 landscape 480p without changing Wan2, portrait or square presets', () => {
    for (const model of [LIVE, 'aliyun/wan3.0-video-prime']) {
      expect(videoGenerationOptions({ provider: 'relay', model })?.sizes).toEqual(['1920x1080', '1080x1920', '1280x720', '720x1280', '854x480', '480x832', '624x624']);
    }
    expect(videoGenerationOptions({ provider: 'relay', model: STALE })?.sizes).toEqual(['1920x1080', '1080x1920', '1440x1440', '832x480', '480x832', '624x624', '1632x1248', '1248x1632']);
  });
  it('preserves a stale saved choice, blocks submission, and sends the explicitly selected live model once', () => {
    const input = props([LIVE]); const { container } = render(<MediaGenerationStudio {...input} />);
    fireEvent.change(container.querySelector('#media-generation-prompt')!, { target: { value: 'Synthetic fixture' } });
    const generate = screen.getByRole('button', { name: 'Generate video' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    const selection = screen.getByRole('combobox', { name: 'Model for this video' }) as HTMLSelectElement;
    expect(selection.value).toBe(STALE);
    fireEvent.change(selection, { target: { value: LIVE } });
    const frame = screen.getByRole('combobox', { name: mediaGenerationCopy('en').videoFrame }) as HTMLSelectElement;
    expect(Array.from(frame.options).map(option => option.value)).toContain('854x480');
    expect(Array.from(frame.options).map(option => option.value)).not.toContain('832x480');
    fireEvent.change(frame, { target: { value: '854x480' } });
    expect(generate.disabled).toBe(false); fireEvent.click(generate);
    expect(input.onGenerate).toHaveBeenCalledTimes(1);
    expect(input.onGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: LIVE, operation: 'text_to_video', mode: 'video', size: '854x480' }));
    expect(input.videoOptions?.text_to_video?.model).toBe(STALE);
  });
  it('keeps a known empty role catalog blocked without presenting a hardcoded replacement', () => {
    const input = props([]); const { container } = render(<MediaGenerationStudio {...input} />);
    fireEvent.change(container.querySelector('#media-generation-prompt')!, { target: { value: 'Synthetic fixture' } });
    expect((screen.getByRole('button', { name: 'Generate video' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('has no model for this operation');
    expect(input.onGenerate).not.toHaveBeenCalled();
  });
  it('offers only the original task status check for an unknown outcome, with no direct retry or new submission', () => {
    const input = props([LIVE]); input.videoOptions!.text_to_video!.model = LIVE;
    input.status = 'error'; input.statusDetail = 'The external commit outcome is unknown. Check the provider before resubmitting.';
    input.retryRequest = { mode: 'video', operation: 'text_to_video', prompt: 'Synthetic fixture', model: LIVE, size: '854x480', duration: 5, requestId: 'original-request' };
    input.onRetry = vi.fn(); input.onCheckTaskStatus = vi.fn();
    const { container } = render(<MediaGenerationStudio {...input} />);
    fireEvent.change(container.querySelector('#media-generation-prompt')!, { target: { value: 'Synthetic fixture' } });
    expect(screen.queryByRole('button', { name: 'Retry same settings' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Generate video' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(container.querySelector('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Check task status' }));
    expect(input.onCheckTaskStatus).toHaveBeenCalledTimes(1);
    expect(input.onGenerate).not.toHaveBeenCalled(); expect(input.onRetry).not.toHaveBeenCalled();
  });
  it('checks the original request through execution_resume without issuing a new chat or generation', () => {
    const emit = vi.fn((_event, data, reply) => reply({ ok: true, snapshot: { requestId: data.requestId } }));
    const previous = { isOpen: false, socket: { connected: true, emit }, mediaGenerationRetryRequest: { requestId: 'original-request' },
      mediaGenerationText: mediaGenerationCopy('en'), chatExecutionSource: 'ai-creation', activeDomain: 'personal', activeOrgId: null,
      attachmentConversationIdRef: { current: 'original-conversation' }, sendText: vi.fn(), setMediaGeneration: vi.fn(),
    };
    const { result } = renderHook(() => useChatMediaControls(previous as any));
    act(() => result.current.checkMediaGenerationStatus());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('agent:execution_resume', { requestId: 'original-request', source: 'ai-creation', domain: 'personal', orgId: null, conversationId: 'original-conversation' }, expect.any(Function));
    expect(previous.sendText).not.toHaveBeenCalled();
  });
  it('retains explicit retry when rejection proves no generation request was submitted', () => {
    const input = props([LIVE]); input.videoOptions!.text_to_video!.model = LIVE;
    input.status = 'error'; input.statusDetail = '当前模型未启用，本次未提交视频生成请求。';
    input.retryRequest = { mode: 'video', operation: 'text_to_video', prompt: 'Synthetic fixture', model: LIVE, size: '854x480', duration: 5 };
    input.onRetry = vi.fn(); render(<MediaGenerationStudio {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same settings' }));
    expect(input.onRetry).toHaveBeenCalledWith(input.retryRequest);
  });
  it('does not replace a known empty catalog with stale fallback options', () => {
    const empty: OfficialApiModelCatalog = { models: [], byRole: { video_generation: [] } };
    expect(officialModelOptions(empty, 'video_generation', [STALE])).toEqual([]);
    expect(officialModelOptions({ models: [], byRole: {} }, 'video_generation', [STALE])).toEqual([]);
  });
});
