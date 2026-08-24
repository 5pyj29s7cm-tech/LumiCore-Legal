import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchSkillWorkflow } from '../server/skills/workflow_registry';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildActionContract } from '../server/cognition/action_contract';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { getDataDirectory } from '../server/config/data_path';
import { initDatabase } from '../db_layer';

const REQUEST = '\u5f8b\u5e08\u7248\u5b9e\u673a\u9a8c\u6536\u00b7\u6807\u4e66\u5236\u4f5c\uff1a\u4e3a\u201c\u56ed\u533aAI\u6cd5\u5f8b\u670d\u52a1\u8bd5\u70b9\u9879\u76ee\u201d\u5236\u4f5c\u4e00\u4efd\u5185\u90e8\u6295\u6807\u54cd\u5e94\u5de5\u4f5c\u5e95\u7a3f\u3002\u53ea\u4f9d\u636e\u4ee5\u4e0b\u6a21\u62df\u62db\u6807\u8981\u6c42\uff1a\u91c7\u8d2d\u5185\u5bb9\u4e3a\u672c\u5730\u90e8\u7f72\u7684AI\u6cd5\u5f8b\u670d\u52a1\u8f6f\u4ef6\u8bd5\u70b9\uff1b\u6295\u6807\u4eba\u8d44\u8d28\u672a\u63d0\u4f9b\uff0c\u5fc5\u987b\u6807\u8bb0\u5f85\u786e\u8ba4\uff1b\u4e0d\u5f97\u5f15\u7528\u65e0\u6cd5\u6838\u9a8c\u7684\u6cd5\u6761\u6216\u6848\u4f8b\u3002\u4e0d\u8981\u767b\u5f55\u5916\u90e8\u7f51\u7ad9\uff0c\u4e0d\u8981\u4e0a\u4f20\u3001\u53d1\u9001\u3001\u63d0\u4ea4\u3001\u7b7e\u7f72\u6216\u6295\u6807\u3002';

describe('verified legal bid draft workflow', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('wins routing over authority research for a safe internal bid draft', () => {
    const workflow = matchSkillWorkflow(REQUEST);
    expect(workflow?.id).toBe('verified_bid_draft');
    expect(workflow?.requiredTools).toEqual(['legal_generate_bid']);
    expect(normalizeActionIntent(`${REQUEST}\u5b8c\u6210\u540e\u544a\u8bc9\u6211\u4efb\u52a1\u56de\u6267\u72b6\u6001\u3002`).kind).not.toBe('status_query');
    expect(buildActionContract(REQUEST).kind).toBe('legal_document');
  });

  it('does not hijack navigation or a formal submission request', () => {
    expect(matchSkillWorkflow('\u6253\u5f00\u6807\u4e66\u5236\u4f5c\u5de5\u4f5c\u53f0\uff0c\u53ea\u6267\u884c\u5ba2\u6237\u7aef\u5bfc\u822a')).toBeNull();
    expect(matchSkillWorkflow('\u628a\u8fd9\u4efd\u6807\u4e66\u4e0a\u4f20\u5e76\u63d0\u4ea4\u5230\u6295\u6807\u7f51\u7ad9')).toBeNull();
  });

  it('calls the bid tool with the exact project and grounded requirements', async () => {
    const workflow = matchSkillWorkflow(REQUEST)!;
    const desktopRelay = vi.fn(async () => '\u5df2\u751f\u6210\u5e76\u5f52\u6863\u5de5\u4f5c\u5e95\u7a3f');
    const result = await workflow.run({
      socket: {} as any,
      userText: REQUEST,
      userId: 'u1',
      desktopRelay,
      speak: () => 0,
      voiceScope: { domain: 'personal', orgId: '' },
    });

    expect(desktopRelay).toHaveBeenCalledWith('legal_generate_bid', expect.objectContaining({
      projectName: '\u56ed\u533aAI\u6cd5\u5f8b\u670d\u52a1\u8bd5\u70b9\u9879\u76ee',
      caseName: '\u56ed\u533aAI\u6cd5\u5f8b\u670d\u52a1\u8bd5\u70b9\u9879\u76ee',
      persistCase: true,
      useModel: false,
      requirements: expect.stringContaining('\u672c\u5730\u90e8\u7f72'),
    }));
    expect(result.responseText).toContain('legal_generate_bid');
    expect(result.responseText).toContain('\u672a\u4e0a\u4f20\u3001\u53d1\u9001\u3001\u63d0\u4ea4\u3001\u7b7e\u7f72\u6216\u6295\u6807');
  });

  it('writes and verifies a real DOCX bid artifact', async () => {
    const legalDeliveryRoot = getDataDirectory(path.join('legal_delivery', 'bid-test'));
    const outputDir = fs.mkdtempSync(path.join(legalDeliveryRoot, 'verified-bid-'));
    try {
      const registry = new ToolRegistry();
      registerLegalTools(registry);
      const record = await executeToolCall({
        registry,
        name: 'legal_generate_bid',
        arguments: {
          projectName: 'Verified Bid Artifact',
          requirements: 'Prepare an internal response matrix. Qualifications, pricing, signature, and submission remain pending review.',
          outputDir,
          orgId: 'bid-test',
          persistCase: false,
          useModel: false,
        },
      });
      expect(record.error).toBeUndefined();
      expect(record.terminalVerification?.status).toBe('verified');
      const artifacts = (record.receipt as any)?.artifacts || [];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatch(/\.docx$/i);
      const bytes = fs.readFileSync(artifacts[0]);
      expect(bytes.length).toBeGreaterThan(256);
      expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(bytes.includes(Buffer.from('[Content_Types].xml'))).toBe(true);
      expect(bytes.includes(Buffer.from('word/document.xml'))).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects a bid output directory outside the legal delivery root', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-legal-bid-outside-'));
    try {
      const registry = new ToolRegistry();
      registerLegalTools(registry);
      const record = await executeToolCall({
        registry,
        name: 'legal_generate_bid',
        arguments: {
          projectName: 'Rejected Bid Artifact',
          requirements: 'Keep this draft inside the scoped legal delivery root.',
          outputDir,
          orgId: 'bid-path-boundary-test',
          persistCase: false,
          useModel: false,
        },
      });
      expect(record.error).toContain('must stay within the legal delivery root');
      expect(record.terminalVerification?.status).not.toBe('verified');
      expect(fs.readdirSync(outputDir)).toEqual([]);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects a junction escape before creating directories outside the legal delivery root', async () => {
    const orgId = `bid-link-boundary-${Date.now()}`;
    const legalDeliveryRoot = getDataDirectory(path.join('legal_delivery', orgId));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-legal-bid-link-outside-'));
    const link = path.join(legalDeliveryRoot, 'escaped-link');
    const escapedOutput = path.join(link, 'must-not-be-created');
    fs.mkdirSync(legalDeliveryRoot, { recursive: true });
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const registry = new ToolRegistry();
      registerLegalTools(registry);
      const record = await executeToolCall({
        registry,
        name: 'legal_generate_bid',
        arguments: {
          projectName: 'Rejected Linked Bid Artifact',
          requirements: 'Do not follow a linked directory outside the scoped delivery root.',
          outputDir: escapedOutput,
          orgId,
          persistCase: false,
          useModel: false,
        },
      });
      expect(record.error).toContain('must stay within the legal delivery root');
      expect(record.terminalVerification?.status).not.toBe('verified');
      expect(fs.existsSync(path.join(outside, 'must-not-be-created'))).toBe(false);
    } finally {
      if (fs.existsSync(link)) fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(legalDeliveryRoot, { recursive: true, force: true });
    }
  });
});
