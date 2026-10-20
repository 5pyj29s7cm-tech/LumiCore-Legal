import { expect, it } from 'vitest';
import sharp from 'sharp';
import { CHAT_SONG_DEFAULT_BRIEF, type ChatSongProject } from '../shared/chat_song';
import { CHAT_SONG_TEMPLATE, chatSongAnimationWindows, chatSongScene } from '../shared/chat_song_layout';
import { chatSongRenderTimeline, createChatSongFrameRenderer } from '../server/creative/chat_song_render';

const project: ChatSongProject = {
  id: '11111111-1111-4111-8111-111111111111', revision: 2, scriptRevision: 1, title: 'Synthetic motion check',
  brief: { ...CHAT_SONG_DEFAULT_BRIEF, roleA: '模拟律师', roleB: '模拟客户', displayNameA: '林律师', displayNameB: '陈女士' },
  lines: [{ id: '01', role: 'A', text: '模拟资料齐了吗？', group: 1, reaction: '惊讶' }, { id: '02', role: 'B', text: '还差最后一页。', group: 1, reaction: '无奈' }, { id: '03', role: 'A', text: '我先核对原件。', group: 2, reaction: '' }, { id: '04', role: 'B', text: '明天补齐。', group: 2, reaction: '' }],
  assets: [{ id: 'reaction', kind: 'reaction', lineId: '01', fileId: 'meme.png', name: 'Synthetic meme', sha256: 'a'.repeat(64) }],
  scriptLocked: true, song: { fileId: 'song.wav', name: 'Synthetic tone', sha256: 'b'.repeat(64), duration: 12, scriptRevision: 1, confirmed: false },
  timings: [{ lineId: '01', start: 1.001, end: 2.5 }, { lineId: '02', start: 4, end: 5.5 }, { lineId: '03', start: 7, end: 8.5 }, { lineId: '04', start: 10, end: 11.5 }], updatedAt: '2026-10-18T00:00:00Z',
};

it('keeps a timed frame blank until its actual onset and delays its large reaction', () => {
  expect(chatSongScene(project, project.lines, 1).messages).toHaveLength(0);
  expect(chatSongScene(project, [], 1.04).messages.map(row => row.line.id)).toEqual(['01']);
  expect(chatSongScene(project, [], 1.1).reaction!.pose.opacity).toBe(0);
  const settled = chatSongScene(project, [], 1.7);
  expect(settled.reaction!.pose.opacity).toBe(1);
  expect(settled.reaction!.pose.width).toBe(500);
  expect(chatSongScene(project, [], 4).messages.map(row => row.line.id)).toEqual(['02']);
  expect(project.song!.confirmed).toBe(false);
});
it('uses four entry directions without applying a semantic classifier or modifying a saved group', () => {
  const directions = project.lines.map((line, index) => {
    const onset = project.timings[index].start;
    const entry = chatSongScene(project, [], onset + 0.04).messages[0].pose;
    const settled = chatSongScene(project, [], onset + 0.6).messages[0].pose;
    expect(entry.width).toBeLessThan(settled.width);
    expect(entry.angle).not.toBe(settled.angle);
    const dx = entry.centerX - settled.centerX, dy = entry.centerY - settled.centerY;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'below' : 'above');
  });
  expect(new Set(directions).size).toBe(4);
  expect(project.lines.map(row => row.group)).toEqual([1, 1, 2, 2]);
});
it('keeps rotated screenshots and reaction stickers inside the frame and separates text from stickers', () => {
  for (const seconds of [1.04, 1.2, 1.4, 1.7, 3.95, 4.1, 7.1, 10.1]) {
    const scene = chatSongScene(project, [], seconds);
    for (const pose of [...scene.messages.map(row => row.pose), ...(scene.reaction ? [scene.reaction.pose] : [])]) {
      const radians = pose.angle * Math.PI / 180;
      const w = Math.abs(pose.width * Math.cos(radians)) + Math.abs(pose.height * Math.sin(radians));
      const h = Math.abs(pose.height * Math.cos(radians)) + Math.abs(pose.width * Math.sin(radians));
      expect(pose.centerX - w / 2).toBeGreaterThanOrEqual(23);
      expect(pose.centerX + w / 2).toBeLessThanOrEqual(CHAT_SONG_TEMPLATE.width - 23);
      expect(pose.centerY - h / 2).toBeGreaterThanOrEqual(23);
      expect(pose.centerY + h / 2).toBeLessThanOrEqual(CHAT_SONG_TEMPLATE.height - 23);
    }
    if (scene.reaction && scene.reaction.pose.opacity > 0) {
      const message = scene.messages.at(-1)!.pose, reaction = scene.reaction.pose;
      expect(reaction.centerY - reaction.height / 2).toBeGreaterThan(message.centerY + message.height / 2);
    }
  }
});
it('reserves a complete conversation layout while revealing only messages whose real times have arrived', () => {
  const conversation = { ...project, brief: { ...project.brief, messageLayout: 'conversation' as const } };
  const first = chatSongScene(conversation, [], 1.8), later = chatSongScene(conversation, [], 4.8);
  expect(first.messages).toHaveLength(1); expect(later.messages.map(row => row.line.id)).toEqual(['01','02']);
  expect(first.messages[0].pose).toEqual(later.messages[0].pose);
});
it('keeps the long-film timeline sparse and rounds up every real onset', () => {
  expect(chatSongRenderTimeline(project)[1].seconds).toBe(1.04);
  const long = { ...project, song: { ...project.song!, duration: 300 } };
  expect(chatSongRenderTimeline(long).length).toBeLessThan(100);
  expect(chatSongAnimationWindows(project).some(window => window.start === 3.88)).toBe(true);
  expect(chatSongRenderTimeline(project).reduce((total, row) => total + row.duration, 0)).toBeCloseTo(12, 7);
});
it('draws the actual sparse-frame compositor using shared poses without changing source inputs', async () => {
  const snapshot = structuredClone(project);
  const image = await (sharp as any)({ create: { width: 120, height: 100, channels: 3, background: '#f59e0b' } }).png().toBuffer();
  const draw = await createChatSongFrameRenderer(project, new Map([['reaction:01', image]]));
  const before = await sharp(await draw(0.9)).ensureAlpha().raw().toBuffer();
  expect(before.some((value, index) => index % 4 === 3 && value !== 0)).toBe(false);
  const entered = await draw(1.1), settled = await draw(1.8);
  expect(entered.equals(settled)).toBe(false);
  const scene = chatSongScene(project, [], 1.8);
  const point = scene.reaction!.pose;
  const pixel = await sharp(settled).extract({ left: Math.round(point.centerX), top: Math.round(point.centerY), width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
  expect([...pixel]).toEqual([245,158,11,255]);
  expect(project).toEqual(snapshot);
});
