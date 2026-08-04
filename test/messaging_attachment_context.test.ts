import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';

let cleanup = () => {};
let attachmentContext: typeof import('../server/messaging/attachment_context');
let messagingRoutes: typeof import('../server/messaging/routes');

function incoming(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'feishu',
    userId: 'ou-member-a',
    userName: 'Member A',
    chatId: 'oc-case-chat',
    chatType: 'group',
    threadId: 'thread-a',
    messageId: `message-${Date.now()}-${Math.random()}`,
    text: '请阅读这份材料',
    boundUserId: 'lumi-member-a',
    boundOrgId: 'org-a',
    raw: {},
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

describe('remote messaging attachment context', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    [attachmentContext, messagingRoutes] = await Promise.all([
      import('../server/messaging/attachment_context'),
      import('../server/messaging/routes'),
    ]);
  });

  beforeEach(() => attachmentContext.resetRemoteAttachmentContextForTest());

  afterAll(() => {
    attachmentContext.resetRemoteAttachmentContextForTest();
    cleanup();
  });

  it('carries verified files only within the exact organization member chat and thread', () => {
    const first = attachmentContext.applyRemoteAttachmentContext(incoming({
      attachments: [{
        id: 'file-a',
        type: 'file',
        fileName: 'case.pdf',
        localPath: 'C:\\Lumi\\messaging\\case.pdf',
        extractedText: 'contract evidence',
      }],
    }));
    expect(first.attachments).toHaveLength(1);

    const followup = attachmentContext.applyRemoteAttachmentContext(incoming({ text: '其中的付款时间是什么？' }));
    expect(followup.attachments).toHaveLength(1);
    expect(followup.text).toContain('do not ask for another upload');
    expect(followup.text).toContain('contract evidence');

    const otherMember = attachmentContext.applyRemoteAttachmentContext(incoming({
      userId: 'ou-member-b',
      boundUserId: 'lumi-member-b',
      text: '能看到材料吗？',
    }));
    expect(otherMember.attachments).toBeUndefined();

    const otherThread = attachmentContext.applyRemoteAttachmentContext(incoming({
      threadId: 'thread-b',
      text: '能看到材料吗？',
    }));
    expect(otherThread.attachments).toBeUndefined();
  });

  it('supports an explicit clear command for the current remote conversation', () => {
    attachmentContext.applyRemoteAttachmentContext(incoming({
      attachments: [{
        id: 'file-a',
        type: 'file',
        fileName: 'case.pdf',
        localPath: 'C:\\Lumi\\messaging\\case.pdf',
      }],
    }));

    const cleared = attachmentContext.applyRemoteAttachmentContext(incoming({ text: '清除会话材料' }));
    expect(cleared.raw.lumiAttachmentContext).toMatchObject({ cleared: true, totalCount: 0 });
    expect(attachmentContext.applyRemoteAttachmentContext(incoming({ text: '继续' })).attachments).toBeUndefined();
  });

  it('breaks a long remote wall of text into mobile-friendly paragraphs', () => {
    const dense = '第一段说明需要核对事实。第二段说明需要补充证据。第三段说明需要确认期限。第四段说明需要律师复核。'.repeat(3);
    const readable = messagingRoutes.formatRemoteReplyForReadability(dense);
    expect(readable).toContain('\n\n');
    expect(readable.split('\n\n').every(paragraph => paragraph.length <= 180)).toBe(true);
  });
});
